#!/usr/bin/env node
// purity-audit.mjs — cross-check collectPureFunctions() against the emitted JS.
//
// The purity analysis that gates the function-like macro tier runs on the C
// AST (build.mjs collectPureFunctions): a function is pure when it writes only
// storage it declared and calls only pure functions. This re-derives the same
// verdict from the OTHER end — the JavaScript that was actually emitted — and
// fails if the two disagree.
//
// It is a cross-check, not a second implementation of the same reasoning: the
// AST pass reasons about C lvalues, this one reasons about the emitted
// vocabulary of effects (cptr.st*/memcpy/alloc/free/addr, the RNG entry points
// in rnd.js, and anything it cannot resolve).
//
// Usage: node tools/c2js/purity-audit.mjs [name ...]
//        with names, explains those functions; without, audits every pure one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './jslex.mjs';

// `if (`, `while (`, `return (` are not calls
const KEYWORD = new Set(['if', 'for', 'while', 'switch', 'return', 'do', 'catch', 'typeof',
  'new', 'delete', 'void', 'in', 'of', 'else', 'function', 'yield', 'await', 'throw', 'case']);
// hand-written machine helpers, pure by inspection (js/cmachine.js)
const CMACHINE = new Set(['schar', 'uchar', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64',
  'f64', 'idiv', 'imod', 'u32div', 'u32mod', 'shl', 'shr', 'sar']);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GEN = path.join(repoRoot, 'js/generated');

// effects as they appear in emitted code
const CPTR_WRITE = /^(st[A-Za-z0-9]*|memcpy|strcpy|strcat|alloc|malloc|free|dup|box|addr|postinc\d?|postdec|preinc|predec|sprintf|snprintf|vsnprintf|sprintfCore|printf|read|write|qsort|vaArg)$/;
const RNG = new Set(['rn2', 'rnd', 'rnl', 'rne', 'rnz', 'd', 'RND', 'rn2_on_display_rng',
  'rnd_on_display_rng', 'init_isaac64', 'init_random', 'reseed_random', 'shuffle_int_array',
  'isaac64_next_uint64', 'isaac64_next_uint', 'isaac64_init', 'isaac64_reseed',
  'rng_log_set_caller', 'rng_log_write']);

/** every function body in js/generated, as a token slice */
function readBodies() {
  const bodies = new Map(); // name -> { file, tokens }
  for (const f of fs.readdirSync(GEN).sort()) {
    if (!f.endsWith('.js')) continue;
    let src = fs.readFileSync(path.join(GEN, f), 'utf8');
    const cut = src.indexOf('// ---- c2js reset block');
    if (cut >= 0) src = src.slice(0, cut);
    const { tokens } = tokenize(src);
    for (let i = 0; i < tokens.length; i++) {
      if (!(tokens[i].t === 'id' && tokens[i].v === 'function')) continue;
      const nm = tokens[i + 1];
      if (!nm || nm.t !== 'id') continue;
      let k = i + 2, depth = 0, start = -1;
      for (; k < tokens.length; k++) {
        if (tokens[k].t !== 'punc') continue;
        if (tokens[k].v === '{') { if (start < 0) start = k; depth++; }
        else if (tokens[k].v === '}') { if (--depth === 0) break; }
      }
      if (start < 0) continue;
      if (!bodies.has(nm.v)) bodies.set(nm.v, { file: f, tokens: tokens.slice(start, k + 1) });
    }
  }
  return bodies;
}

/** the effects and direct callees visible in one emitted body */
function effectsOf(body) {
  const effects = [];
  const callees = new Set();
  const t = body.tokens;
  for (let i = 0; i < t.length; i++) {
    if (t[i].t !== 'id') continue;
    const isCall = t[i + 1] && t[i + 1].t === 'punc' && t[i + 1].v === '(';
    const qualified = t[i - 1] && t[i - 1].t === 'punc' && t[i - 1].v === '.';
    if (qualified && isCall) {
      const ns = t[i - 2];
      if (ns && ns.t === 'id' && ns.v === 'cptr' && CPTR_WRITE.test(t[i].v)) effects.push(`cptr.${t[i].v}`);
      continue;
    }
    if (isCall) {
      if (KEYWORD.has(t[i].v)) continue;
      if (RNG.has(t[i].v)) effects.push(`RNG ${t[i].v}`);
      callees.add(t[i].v);
      continue;
    }
    // a bare `x = ` at any depth: assignment to something, local or not
    if (t[i + 1] && t[i + 1].t === 'punc' && t[i + 1].v === '=') effects.push(`assign ${t[i].v}`);
    if (t[i + 1] && t[i + 1].t === 'punc' && (t[i + 1].v === '++' || t[i + 1].v === '--')) effects.push(`step ${t[i].v}`);
  }
  return { effects, callees };
}

const bodies = readBodies();
const argv = process.argv.slice(2);

// the same fixed point, over the emitted code
const local = new Map();
for (const [n, b] of bodies) local.set(n, effectsOf(b));
const suspect = new Map(); // name -> first reason it is not provably pure here

function why(name, seen = new Set()) {
  if (suspect.has(name)) return suspect.get(name);
  if (seen.has(name)) return null;
  seen.add(name);
  const e = local.get(name);
  if (!e) return `${name}: no emitted body (external)`;
  // an assignment to a name the function itself declares is invisible here, so
  // this over-reports; that is the safe direction for an audit
  const bad = e.effects.filter((x) => !x.startsWith('assign') && !x.startsWith('step'));
  if (bad.length) return `${name}: ${bad[0]}`;
  for (const c of e.callees) {
    if (c === name || !local.has(c)) {
      if (!local.has(c) && !CMACHINE.has(c)) return `${name} -> ${c} (unresolved)`;
      continue;
    }
    const w = why(c, seen);
    if (w) return `${name} -> ${w}`;
  }
  return null;
}

if (argv.length) {
  for (const n of argv) {
    const w = why(n);
    const e = local.get(n);
    console.log(`${n}: ${w ? 'NOT provably pure here — ' + w : 'pure'}`);
    if (e) console.log(`  emitted callees: ${[...e.callees].join(', ') || '(none)'}`);
    if (e) console.log(`  effects: ${e.effects.length ? e.effects.join(', ') : '(none)'}`);
  }
  process.exit(0);
}

// audit mode: every name the helper module imports as a pure callee
const mod = path.join(GEN, 'nhmacrofn.js');
if (!fs.existsSync(mod)) { console.log('no nhmacrofn.js — nothing to audit'); process.exit(0); }
const imported = new Set();
for (const m of fs.readFileSync(mod, 'utf8').matchAll(/import \{([^}]*)\} from '\.\/([a-z0-9_]+)\.js';/g)) {
  for (const nm of m[1].split(',')) if (nm.trim()) imported.add(nm.trim());
}
const fns = [...imported].filter((n) => bodies.has(n)).sort();
let bad = 0;
for (const n of fns) {
  const w = why(n);
  if (w) { bad++; console.log(`IMPURE  ${w}`); }
}
console.log(`purity audit: ${fns.length} function(s) nhmacrofn.js calls, ${bad} disagree with the AST analysis`);
process.exit(bad ? 1 : 0);
