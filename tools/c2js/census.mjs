#!/usr/bin/env node
// census.mjs — AST node-kind census over NetHack src/*.c and Lua lib sources,
// restricted to main-file declarations/statements.
//
// Usage: node tools/c2js/census.mjs [--skip-dump]
//
// Writes .cache/c2js/census.txt and prints a compact summary to stdout.
//
// Main-file filtering rule: see ir.mjs (canonical implementation, imported
// below). Summary: mirror clang JSONNodeDumper's LastLocFilename state
// machine; a node is main-file iff its effective location (loc, else
// range.begin; macro locs resolved through expansionLoc) resolves to the
// main file path with no includedFrom.

import fs from 'node:fs';
import path from 'node:path';
import { dumpAst, astPathFor, compileCwdFor, NETHACK_SRC, LUA_SRC, AST_DIR } from './ast-dump.mjs';
import { makeLocationTracker, lineIndexFor, lineOf } from './ir.mjs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT = path.join(repoRoot, '.cache/c2js/census.txt');
const CONCURRENCY = 4;

const SKIP_LUA = new Set(['lua.c', 'luac.c', 'onelua.c']);

function listCFiles(dir, skip = new Set()) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.c') && !skip.has(f))
    .sort()
    .map((f) => path.join(dir, f));
}

// ---------- helpers ----------

function* iterInner(n) {
  if (n.inner) for (const c of n.inner) yield c;
}

// does this subtree contain a DeclRefExpr to a FunctionDecl?
function subtreeCallsFunction(n) {
  if (!n || typeof n !== 'object') return false;
  if (n.kind === 'DeclRefExpr' && n.referencedDecl && n.referencedDecl.kind === 'FunctionDecl') return true;
  for (const c of iterInner(n)) if (subtreeCallsFunction(c)) return true;
  return false;
}
function calleeFunctionName(callExpr) {
  let name;
  (function rec(n) {
    if (name || !n || typeof n !== 'object') return;
    if (n.kind === 'DeclRefExpr' && n.referencedDecl && n.referencedDecl.kind === 'FunctionDecl') {
      name = n.referencedDecl.name;
      return;
    }
    for (const c of iterInner(n)) rec(c);
  })(callExpr.inner && callExpr.inner[0]);
  return name;
}

const SETJMP_NAMES = new Set([
  'setjmp', 'longjmp', '_setjmp', '_longjmp', 'sigsetjmp', 'siglongjmp',
  '__builtin_setjmp', '__builtin_longjmp',
]);

const HARD_KINDS = ['GotoStmt', 'AddrLabelExpr', 'LabelStmt', 'VAArgExpr', 'StmtExpr', 'CompoundAssignOperator'];

// ---------- per-file analysis ----------

export function analyzeFile(astPath, mainFileAbs, compileCwd, group, counts, hard, examples) {
  const root = JSON.parse(fs.readFileSync(astPath, 'utf8'));
  const src = fs.readFileSync(mainFileAbs, 'utf8');
  const lineStarts = lineIndexFor(src);
  const tracker = makeLocationTracker(compileCwd, mainFileAbs);
  const base = path.basename(mainFileAbs);

  const unionFieldIds = new Set(); // ids of FieldDecls inside a union RecordDecl
  const memberExprs = []; // {refId, offset} main-file MemberExprs
  const fnDecls = []; // main-file FunctionDecl names (for validation)

  function example(key, offset) {
    const arr = examples[key] || (examples[key] = []);
    if (arr.length < 2 && offset !== undefined) arr.push(`${base}:${lineOf(lineStarts, offset)}`);
  }
  function bump(key) {
    const c = hard[key] || (hard[key] = { nethack: 0, lua: 0 });
    c[group]++;
  }

  (function walk(n, inUnion) {
    if (!n || typeof n !== 'object' || !n.kind) return;
    const eff = tracker.processNode(n);
    const main = tracker.isMain(eff);
    const kind = n.kind;

    if (kind === 'RecordDecl' && n.tagUsed === 'union') inUnion = true;
    if (inUnion && kind === 'FieldDecl' && n.id) unionFieldIds.add(n.id);

    if (main) {
      const k = counts[kind] || (counts[kind] = { nethack: 0, lua: 0 });
      k[group]++;
      if (kind === 'FunctionDecl') fnDecls.push(n.name);
      if (HARD_KINDS.includes(kind)) { bump(kind); example(kind, eff.offset); }
      if (kind === 'ImplicitCastExpr' && n.castKind === 'BitCast') { bump('BitCast'); example('BitCast', eff.offset); }
      if (kind === 'MemberExpr' && n.referencedMemberDecl) {
        memberExprs.push({ refId: n.referencedMemberDecl, offset: eff.offset });
      }
      if (kind === 'CallExpr') {
        const callee = n.inner && n.inner[0];
        if (!subtreeCallsFunction(callee)) { bump('FnPtrCall'); example('FnPtrCall', eff.offset); }
        const name = calleeFunctionName(n);
        if (name && SETJMP_NAMES.has(name)) { bump('setjmp_longjmp'); example('setjmp_longjmp', eff.offset); }
      }
    }
    for (const c of iterInner(n)) walk(c, inUnion);
  })(root, false);

  // resolve union member accesses now that all FieldDecls are known
  for (const me of memberExprs) {
    if (unionFieldIds.has(me.refId)) { bump('UnionMemberExpr'); example('UnionMemberExpr', me.offset); }
  }
  return fnDecls;
}

// ---------- main ----------

async function main() {
  const skipDump = process.argv.includes('--skip-dump');
  const targets = [
    ...listCFiles(NETHACK_SRC).map((f) => ({ file: f, group: 'nethack' })),
    ...listCFiles(LUA_SRC, SKIP_LUA).map((f) => ({ file: f, group: 'lua' })),
  ];
  console.log(`${targets.length} files (${targets.filter((t) => t.group === 'nethack').length} NetHack, ${targets.filter((t) => t.group === 'lua').length} Lua)`);

  // 1. dump (with modest parallelism)
  const failures = [];
  if (!skipDump) {
    let done = 0;
    const t0 = Date.now();
    async function worker(queue) {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        try {
          await dumpAst(t.file);
        } catch (err) {
          failures.push({ file: t.file, error: String(err.message || err) });
        }
        if (++done % 10 === 0) console.log(`  dumped ${done}/${targets.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }
    const queue = [...targets];
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
    console.log(`dumps done in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${failures.length} failures`);
  }

  // 2. analyze
  const counts = {}; // kind -> {nethack, lua}
  const hard = {}; // category -> {nethack, lua}
  const examples = {}; // category -> [file:line]
  let rndFnDecls = null;
  for (const t of targets) {
    const astPath = astPathFor(t.file);
    if (!fs.existsSync(astPath)) {
      if (!failures.some((f) => f.file === t.file))
        failures.push({ file: t.file, error: 'no AST dump (see .err.log if present)' });
      continue;
    }
    try {
      const fns = analyzeFile(astPath, path.resolve(t.file), compileCwdFor(t.file), t.group, counts, hard, examples);
      if (path.basename(t.file) === 'rnd.c' && t.group === 'nethack') rndFnDecls = fns;
    } catch (err) {
      failures.push({ file: t.file, error: `analysis failed: ${err.message}` });
    }
  }

  // 3. report
  const rows = Object.entries(counts)
    .map(([kind, c]) => ({ kind, nethack: c.nethack, lua: c.lua, total: c.nethack + c.lua }))
    .sort((a, b) => b.total - a.total);
  const hardRows = [...HARD_KINDS, 'BitCast', 'UnionMemberExpr', 'FnPtrCall', 'setjmp_longjmp']
    .map((k) => ({ kind: k, ...(hard[k] || { nethack: 0, lua: 0 }), examples: examples[k] || [] }));

  const fmt = (n) => String(n).padStart(9);
  const lines = [];
  lines.push(`c2js AST census — ${new Date().toISOString()}`);
  lines.push(`files: ${targets.length} (${targets.length - failures.length} ok, ${failures.length} failed)`);
  lines.push('');
  lines.push(`${'kind'.padEnd(38)} ${'NetHack'.padStart(9)} ${'Lua'.padStart(9)} ${'total'.padStart(9)}`);
  for (const r of rows) lines.push(`${r.kind.padEnd(38)}${fmt(r.nethack)}${fmt(r.lua)}${fmt(r.total)}`);
  lines.push('');
  lines.push('hard constructs (main-file only):');
  for (const r of hardRows) {
    lines.push(`  ${r.kind.padEnd(24)} NetHack=${String(r.nethack).padStart(5)}  Lua=${String(r.lua).padStart(5)}  e.g. ${r.examples.join(', ') || '(none)'}`);
  }
  lines.push('');
  if (rndFnDecls) lines.push(`rnd.c main-file FunctionDecls: ${rndFnDecls.join(', ')}`);
  if (failures.length) {
    lines.push('');
    lines.push('failures:');
    for (const f of failures) lines.push(`  ${f.file}: ${f.error.split('\n')[0]}`);
  }
  const report = lines.join('\n') + '\n';
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, report);

  // compact stdout
  console.log('\n=== top 30 node kinds ===');
  console.log(`${'kind'.padEnd(38)} ${'NetHack'.padStart(9)} ${'Lua'.padStart(9)}`);
  for (const r of rows.slice(0, 30)) console.log(`${r.kind.padEnd(38)}${fmt(r.nethack)}${fmt(r.lua)}`);
  console.log('\n=== hard constructs ===');
  for (const r of hardRows) console.log(`  ${r.kind.padEnd(24)} NetHack=${r.nethack}  Lua=${r.lua}  e.g. ${r.examples.join(', ') || '(none)'}`);
  if (failures.length) {
    console.log(`\n=== ${failures.length} failures ===`);
    for (const f of failures) console.log(`  ${path.basename(f.file)}: ${f.error.split('\n')[0]}`);
  }
  console.log(`\nfull report: ${REPORT}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
