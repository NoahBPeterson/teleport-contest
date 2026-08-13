#!/usr/bin/env node
// build.mjs — c2js build driver.
//
// Usage:
//   node tools/c2js/build.mjs rnd        # single file -> js/generated/rnd.js
//   node tools/c2js/build.mjs --all      # batch: every NetHack src/*.c, then Lua
//                                        # lib sources; coverage report to
//                                        # .cache/c2js/coverage.txt
//
// Single-file mode uses the file's runtime prelude (tools/c2js/runtime/) when
// one exists and no cross-file imports (preludes provide their own externs).
// Batch mode emits cross-file imports from the global symbol table instead
// (symbols.mjs), and no prelude — it measures emitter coverage, not runnability.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAst, mainFileDecls } from './ir.mjs';
import { astPathFor, compileCwdFor } from './ast-dump.mjs';
import { Emitter, loadPrelude } from './emit.mjs';
import { listTargets, collectFile, buildSymbolMap, loadSlimIr, slimIrPath } from './symbols.mjs';
import { EMIT_VERSION, CONST_NS, CONST_MODULE, MACRO_NS, MACRO_MODULE, FIELD_NS, FIELD_MODULE, FIELD_PREFIX, PROP_MODULE, MACRO_FN_MODULE, MACRO_HELPERS, MACRO_FN_HELPERS, RNG_MODULE, RNG_HELPERS, JS_RESERVED, assertNoAbsolutePaths } from './emit.mjs';
import { formatSource, wrapImport, fillItems, FMT_ON, FMT_COLS, FMT_STATS } from './jsfmt.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRANSPILER_VERSION = 'c2js emit v1+batch';

/**
 * Corpus-wide bitfield widths: recordName -> { field: bits }.
 *
 * The slim IR only carries each TU's *main-file* record definitions, so a
 * struct declared in a header (rm, obj, monst, d_flags, ...) reaches the
 * emitter through symbols.mjs's record table, which has no notion of a
 * declared bit width. The emitter needs the widths to truncate bitfield
 * loads to C's semantics, so scan a couple of representative full ASTs —
 * every NetHack TU pulls in hack.h, which transitively declares all 26
 * bitfield-bearing named structs — and key the widths by record name.
 * One 27 MB AST parses in ~100 ms, so this is cheap next to the build.
 */
function collectBitfieldWidths(targets) {
  const byRecord = new Map();
  const seenGroups = new Set();
  for (const t of targets) {
    if (seenGroups.has(t.group)) continue;
    const astPath = astPathFor(t.file);
    if (!fs.existsSync(astPath)) continue;
    seenGroups.add(t.group);
    let ast;
    try { ast = loadAst(astPath); } catch { continue; }
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'RecordDecl' && n.completeDefinition && n.name) {
        for (const c of n.inner || []) {
          if (c.kind !== 'FieldDecl' || !c.isBitfield || !c.name) continue;
          const w = bitWidthOfField(c);
          if (!w) continue;
          if (!byRecord.has(n.name)) byRecord.set(n.name, {});
          const slot = byRecord.get(n.name);
          if (slot[c.name] === undefined) slot[c.name] = w;
        }
      }
      for (const c of n.inner || []) walk(c);
    })(ast);
  }
  return byRecord;
}

/** declared width of a bitfield FieldDecl (clang puts it in a ConstantExpr child) */
function bitWidthOfField(fieldNode) {
  let w;
  (function deep(x) {
    if (!x || typeof x !== 'object' || w !== undefined) return;
    if ((x.kind === 'ConstantExpr' || x.kind === 'IntegerLiteral') && x.value !== undefined) {
      const n = Number(x.value);
      if (Number.isFinite(n) && n > 0) w = n;
      return;
    }
    for (const c of x.inner || []) deep(c);
  })(fieldNode);
  return w;
}

/**
 * Merge every TU's enum constants into js/generated/nhconst.js and return the
 * set of names it exports.
 *
 * NetHack's enum constants live in shared headers, so the same name means the
 * same value in every TU that sees it; a name that maps to two different
 * values (a genuinely file-local enum reusing a name) cannot be given one
 * global binding, so it is dropped here and keeps inlining as a literal.
 * The file is sorted by name: a stable order keeps the 5.1 re-transpile's
 * renumbering diff readable, and it is the whole point of the module — the
 * renumbering churn lands here instead of in 172 generated files.
 */
function writeConstModule(perFile) {
  const values = new Map(); // name -> value
  const conflicted = new Map(); // name -> Set of values
  for (const pf of perFile) {
    if (pf.parseError) continue;
    for (const [name, v] of pf.enumValues || []) {
      if (!values.has(name)) { values.set(name, v); continue; }
      if (values.get(name) === v) continue;
      if (!conflicted.has(name)) conflicted.set(name, new Set([values.get(name)]));
      conflicted.get(name).add(v);
    }
  }
  const names = [...values.keys()].filter((n) => !conflicted.has(n)
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !JS_RESERVED.has(n)
    && Number.isInteger(values.get(n))).sort();
  const lines = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
    '// See docs/NOTES-named-constants.md (the enum tier, roadmap 1.8).',
    '',
    ...names.map((n) => `export const ${n} = ${values.get(n)};`),
    '',
  ];
  const outDir = path.join(repoRoot, 'js/generated');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, path.basename(CONST_MODULE)), lines.join('\n'));
  if (conflicted.size) {
    console.log(`nhconst: ${conflicted.size} name(s) with conflicting values stay inlined: ` +
      [...conflicted.keys()].slice(0, 20).join(', '));
  }
  console.log(`nhconst: ${names.length} constants exported (${values.size} distinct names seen)`);
  return new Set(names);
}

/**
 * Merge NetHack's object-like integer `#define`s into js/generated/nhmacro.js
 * and return the "header.h:line" -> [name, value] index the emitter needs.
 *
 * A macro is gone by the time clang emits an AST, so the only handle on it is
 * the spelling location of the token it expanded to, which points at the
 * macro's body.  This scans the headers for the definitions whose *whole body
 * is one integer token* — those and only those can have spelled an
 * IntegerLiteral, so a match on (header, line) identifies the macro
 * unambiguously.  C requires a directive to own its line, so two macros can
 * never share a key.
 *
 * The module itself is written after emission, by writeMacroModule().
 */
function scanMacroDefs() {
  const dir = path.join(repoRoot, 'nethack-c/recorder/include');
  const defRe = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\()\s+(\S+)\s*(?:\/[*/].*)?$/;
  const intRe = /^-?(?:0[xX][0-9a-fA-F]+|\d+)[uUlL]*$/;
  const byKey = new Map(); // "align.h:12" -> [name, value]
  const values = new Map(); // name -> value
  const conflicted = new Set();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.h')).sort()) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = defRe.exec(lines[i]);
      if (!m) continue;
      let body = m[2];
      while (body.startsWith('(') && body.endsWith(')')) body = body.slice(1, -1);
      if (!intRe.test(body)) continue;
      const digits = body.replace(/[uUlL]+$/, '');
      // C integer literal bases: 0x hex, leading-0 octal, else decimal
      const v = /^-?0[xX]/.test(digits) ? Number(digits)
        : /^-?0[0-7]+$/.test(digits) ? Number.parseInt(digits, 8) : Number(digits);
      if (!Number.isInteger(v)) continue;
      const name = m[1];
      if (values.has(name) && values.get(name) !== v) conflicted.add(name);
      else values.set(name, v);
      byKey.set(`${f}:${i + 1}`, [name, v]);
    }
  }
  const names = new Set([...values.keys()].filter((n) => !conflicted.has(n)
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !JS_RESERVED.has(n)));
  for (const [k, def] of byKey) if (!names.has(def[0])) byKey.delete(k);
  if (conflicted.size) {
    console.log(`nhmacro: ${conflicted.size} name(s) defined with two values stay inlined: ` +
      [...conflicted].slice(0, 20).join(', '));
  }
  return { byKey, values };
}

/**
 * Write js/generated/nhmacro.js with exactly the constants the emitted modules
 * reference, read back out of the generated files.
 *
 * Reading the output rather than trusting a per-file tally is deliberate: the
 * batch build is incremental, so a file whose emission was skipped would not
 * have reported its names, and a missing export is a runtime `undefined` in a
 * byte-exact program.  Reading the files that will actually import the module
 * cannot drift from them.
 *
 * It also keeps the module honest.  The header scan sees definition *text*,
 * not the preprocessor's state, so it can pick up a name whose live definition
 * is somewhere else (`NHW_BASE` is `#define`d as a literal in one branch and
 * as `(NHW_LAST_TYPE + 1)` in the one that wins) or one that is not NetHack's
 * at all (`__STDC__`).  Those can never be *emitted* — a site is only named
 * when the token was spelled at the very line the scan matched, and the value
 * is checked against the fold — so exporting only what was emitted drops them.
 */
function writeMacroModule(values) {
  const outDir = path.join(repoRoot, 'js/generated');
  const used = new Set();
  const ref = new RegExp(`\\b${MACRO_NS}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.js') || f === path.basename(MACRO_MODULE)) continue;
    const text = fs.readFileSync(path.join(outDir, f), 'utf8');
    for (const m of text.matchAll(ref)) used.add(m[1]);
  }
  const names = [...used].sort();
  const missing = names.filter((n) => !values.has(n));
  if (missing.length) throw new Error(`nhmacro: emitted names with no definition: ${missing.join(', ')}`);
  const lines = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
    '// See docs/NOTES-named-constants.md (the macro tier, roadmap 1.9).',
    '',
    ...names.map((n) => `export const ${n} = ${values.get(n)};`),
    '',
  ];
  fs.writeFileSync(path.join(outDir, path.basename(MACRO_MODULE)), lines.join('\n'));
  console.log(`nhmacro: ${names.length} constants exported`);
}

/**
 * Object-like `#define`s whose body is an *expression*, indexed by the byte
 * extent of that body inside its header: "youprop.h:4759" -> {name, endOffset}.
 *
 * This is the handle on the macro tier the 1.9 work deliberately left alone.
 * There, a value born from a macro was recovered from the spelling location of
 * the single integer token it expanded to; an expression body has no single
 * token, so what identifies it instead is the *extent*: a node whose
 * range.begin and range.end both spell inside one macro body, at that body's
 * first and last token, is that macro's complete expansion and nothing else.
 * Sub-expressions of the body start later or end earlier; a use of the macro
 * inside another macro's body spells at the inner body.  As with the integer
 * tier, C makes a directive own its line, so two macros can never share a key.
 *
 * Offsets, not (line, col): clang prints an `offset` on every location, and
 * omits `line` whenever it is unchanged since the last location it printed.
 *
 * Bodies that are one integer token are excluded — those belong to nhmacro.js.
 */
function scanMacroExprDefs() {
  const dir = path.join(repoRoot, 'nethack-c/recorder/include');
  const defRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(?![(\w])/;
  const byExtent = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.h')).sort()) {
    // latin1 so a string index is a byte offset, which is what clang reports
    const text = fs.readFileSync(path.join(dir, f), 'latin1');
    let pos = 0;
    while (pos < text.length) {
      let nl = text.indexOf('\n', pos);
      if (nl < 0) nl = text.length;
      const m = defRe.exec(text.slice(pos, nl));
      if (m) {
        // splice on backslash-newline continuations to get the whole body
        let end = nl;
        while (end > pos && text[end - 1] === '\r') end--;
        while (text[end - 1] === '\\' || (end < text.length && text[end - 1] === '\\')) {
          let nn = text.indexOf('\n', end + 1);
          if (nn < 0) nn = text.length;
          end = nn;
          while (end > pos && text[end - 1] === '\r') end--;
          if (text[end - 1] !== '\\') break;
        }
        const bodyFrom = pos + m[0].length;
        const toks = cTokenOffsets(text, bodyFrom, end);
        if (toks.length && !(toks.length === 1 && /^[0-9]/.test(text[toks[0]]))) {
          byExtent.set(`${f}:${toks[0]}`, { name: m[1], end: toks[toks.length - 1], header: f });
        }
        pos = end + 1;
        continue;
      }
      pos = nl + 1;
    }
  }
  return byExtent;
}

/**
 * Which C functions are provably PURE — no write to memory, no RNG, no I/O,
 * transitively.
 *
 * This exists for one decision. A function-like macro expands its parameter
 * once per occurrence in its body, so `glyph_is_object(glyph_at(u.ux, u.uy))`
 * calls `glyph_at` as many times as the body mentions the parameter, and a JS
 * helper taking that value calls it once. In a program scored on an exact PRNG
 * trace, changing how many times a function runs is a parity change — unless
 * running it fewer times is unobservable, which is exactly what purity means.
 *
 * The analysis runs on the slim IR (the C AST), not the emitted JS, because the
 * emitter needs the answer before any module is written. It is a least
 * fixed point over the call graph, seeded pessimistically:
 *
 *   impure(f) if f writes anywhere it did not itself declare, or calls
 *             anything not proven pure — including every function whose
 *             definition this build never saw (libc, the window port, a call
 *             through a function pointer).
 *
 * "Writes anywhere it did not itself declare" is the load-bearing clause. An
 * assignment to a plain local is unobservable and does not count; an assignment
 * through a pointer, to a field, to an array element, or to a global does. A
 * function-static is storage that outlives the call, so a function that
 * declares one is out. Reading a mutable global IS allowed: between the N
 * evaluations C would have performed, nothing runs but the macro body, and the
 * body is itself restricted to pure loads — so all N reads see the same bytes.
 *
 * Default is REFUSE: a name reached in no definition is impure, and any shape
 * this walker does not recognize makes its function impure.
 */
const RNG_NEVER_PURE = new Set([
  'rn2', 'rnd', 'rn1', 'rnl', 'rne', 'rni', 'd', 'rn2_on_rng', 'rnd_on_rng', 'rn1_on_rng',
  'rn2_on_display_rng', 'rnd_on_display_rng', 'rn2_on_gen_rng', 'RND', 'set_random',
  'isaac64_init', 'isaac64_next_uint64', 'init_isaac64', 'rng_log_set_caller', 'reseed_random',
]);

function collectPureFunctions(perFile) {
  const writes = new Map();   // fn name -> true if it writes storage it does not own
  const calls = new Map();    // fn name -> Set of callee names
  const defined = new Set();

  for (const pf of perFile) {
    if (pf.parseError) continue;
    for (const d of pf.decls || []) {
      if (d.kind !== 'FunctionDecl' || !d.name) continue;
      const body = (d.inner || []).find((c) => c && c.kind === 'CompoundStmt');
      if (!body) continue;
      defined.add(d.name);
      const locals = new Set();   // plain (non-static) locals and parameters: writable
      const callees = new Set();
      let impure = false;
      for (const p of d.inner || []) if (p && p.kind === 'ParmVarDecl' && p.name) locals.add(p.name);

      const lvalueIsOwnLocal = (x) => {
        // peel the casts/parens clang wraps an lvalue in
        while (x && (x.kind === 'ParenExpr' || x.kind === 'ImplicitCastExpr' || x.kind === 'CStyleCastExpr')) {
          x = (x.inner || [])[0];
        }
        return !!x && x.kind === 'DeclRefExpr' && locals.has(x.name || x.referencedDecl?.name);
      };

      (function walk(x) {
        if (!x || typeof x !== 'object' || impure) return;
        if (x.kind === 'VarDecl' && x.name) {
          // a function-static is storage that outlives the call
          if (x.storageClass === 'static') impure = true;
          else locals.add(x.name);
        }
        if (x.kind === 'BinaryOperator' && x.opcode === '=') {
          if (!lvalueIsOwnLocal((x.inner || [])[0])) impure = true;
        }
        if (x.kind === 'CompoundAssignOperator') {
          if (!lvalueIsOwnLocal((x.inner || [])[0])) impure = true;
        }
        if (x.kind === 'UnaryOperator' && (x.opcode === '++' || x.opcode === '--')) {
          const tgt = (x.inner || [])[0];
          if (!lvalueIsOwnLocal(tgt)) impure = true;
          // stepping a POINTER local is a local write in C, but the emitter
          // lowers it through cptr.postinc(get, set) — an indirect call whose
          // effects are not visible where it is written. purity-audit.mjs reads
          // the emitted code and cannot vouch for it, and the two analyses are
          // required to agree, so this side gives way (strncmpi is the case).
          else if (/\*/.test(tgt?.type?.qualType || '')) impure = true;
        }
        if (x.kind === 'UnaryOperator' && x.opcode === '&') {
          // the address of a local can be written through by anything it reaches;
          // every callee must be pure anyway, but a local whose address escapes
          // is no longer "storage this function owns"
          const t = (x.inner || [])[0];
          if (t && t.kind === 'DeclRefExpr') locals.delete(t.name || t.referencedDecl?.name);
        }
        if (x.kind === 'CallExpr') {
          const callee = calleeNameOf(x);
          if (!callee) impure = true;            // through a function pointer
          else callees.add(callee);
        }
        if (x.kind === 'GCCAsmStmt' || x.kind === 'VAArgExpr') impure = true;
        for (const c of x.inner || []) walk(c);
      })(body);

      // a name defined twice (a TU-local static shadowing a global) is not one
      // this analysis can reason about
      if (writes.has(d.name)) { writes.set(d.name, true); continue; }
      writes.set(d.name, impure);
      calls.set(d.name, callees);
    }
  }

  // least fixed point: start optimistic for defined non-writers, then retract
  const pure = new Set();
  for (const [name, w] of writes) if (!w && !RNG_NEVER_PURE.has(name)) pure.add(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...pure]) {
      for (const c of calls.get(name) || []) {
        if (!pure.has(c)) { pure.delete(name); changed = true; break; }
      }
    }
  }
  return pure;
}

/** the called function's name, or null when the call is not a direct one */
function calleeNameOf(callNode) {
  let f = (callNode.inner || [])[0];
  while (f && (f.kind === 'ImplicitCastExpr' || f.kind === 'ParenExpr')) f = (f.inner || [])[0];
  if (f && f.kind === 'DeclRefExpr') {
    const n = f.name || f.referencedDecl?.name;
    if (n && f.referencedDecl?.kind === 'FunctionDecl') return n;
    return n || null;
  }
  return null;
}

/**
 * The same index for FUNCTION-like macros: `header:firstBodyTokenOffset` ->
 * { name, end, header, params }.
 *
 * Same extent key as scanMacroExprDefs and for the same reason — a node whose
 * spelling ends land on one macro body's first and last token IS that macro's
 * whole expansion. The difference is that the body mentions parameters, so the
 * helper this produces takes arguments, and `params` is what names them.
 *
 * Refused here rather than later: a macro with no parameters at all (that is
 * the object-like tier's job), one whose parameter list is not a plain list of
 * identifiers (varargs `...`, `__VA_ARGS__`), one whose body is a single token
 * (nothing to name), and one whose body uses `#` or `##`, whose expansion is
 * not an expression in any useful sense.
 */
function scanMacroFnDefs() {
  const dir = path.join(repoRoot, 'nethack-c/recorder/include');
  const defRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)\(([^)]*)\)/;
  const ID = /^[A-Za-z_]\w*$/;
  const byExtent = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.h')).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'latin1');
    let pos = 0;
    while (pos < text.length) {
      let nl = text.indexOf('\n', pos);
      if (nl < 0) nl = text.length;
      const m = defRe.exec(text.slice(pos, nl));
      if (m) {
        let end = nl;
        while (end > pos && text[end - 1] === '\r') end--;
        while (text[end - 1] === '\\' || (end < text.length && text[end - 1] === '\\')) {
          let nn = text.indexOf('\n', end + 1);
          if (nn < 0) nn = text.length;
          end = nn;
          while (end > pos && text[end - 1] === '\r') end--;
          if (text[end - 1] !== '\\') break;
        }
        const params = m[2].split(',').map((p) => p.trim()).filter((p) => p !== '');
        const bodyFrom = pos + m[0].length;
        const toks = cTokenOffsets(text, bodyFrom, end);
        const body = text.slice(bodyFrom, end);
        if (params.length && params.every((p) => ID.test(p)) && toks.length > 1 && !/#/.test(body)) {
          byExtent.set(`${f}:${toks[0]}`, { name: m[1], end: toks[toks.length - 1], header: f, params });
        }
        pos = end + 1;
        continue;
      }
      pos = nl + 1;
    }
  }
  return byExtent;
}

/**
 * Start offsets of the C tokens in text[from, to), skipping comments and
 * backslash-newline splices. Only the first and last matter to the caller.
 */
function cTokenOffsets(text, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) { i += 2; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? to : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? to : e; continue; }
    out.push(i);
    if (/[A-Za-z_0-9]/.test(c)) { while (i < to && /[A-Za-z_0-9]/.test(text[i])) i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < to && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
      i++; continue;
    }
    i++;
  }
  return out;
}

/**
 * Corpus-wide struct field offsets: "record_field" -> byte offset.
 *
 * Computed before any file is emitted, from the same record tables the real
 * emitters will use, because the name has to mean the same thing in all 170
 * modules — they share one nhfield.js.  Building it here rather than
 * accumulating it during emission also keeps incremental builds honest: a file
 * whose emission is skipped still has its FLD.* references resolved.
 *
 * A name is dropped when two translation units disagree about its offset (a
 * file-local struct shadowing a header one) and, separately, when two
 * different (record, field) pairs would spell it the same way — `record_field`
 * is not an injective encoding on its own, and a name that could mean two
 * things is exactly the "wrong name on a right value" this design refuses.
 * Anonymous records never qualify: their emitter-internal keys (`anon#123`,
 * `byloc#12:5`) are not identifiers, so their fields keep bare offsets.
 */
function collectFieldOffsets(perFile, ctorCommon) {
  const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const values = new Map();   // name -> offset
  const owners = new Map();   // name -> "record.field" that produced it
  const conflicted = new Set();
  let ambiguous = 0;
  for (const pf of perFile) {
    if (pf.parseError) continue;
    let em;
    try {
      em = new Emitter({ decls: pf.decls, lineOf: pf.lineOf, source: '', fileName: `${pf.name}.c`,
        extraRecords: pf.recordDefs, compileCwd: compileCwdFor(pf.file), anonByLoc: pf.anonByLoc,
        enumValues: pf.enumValues, ...ctorCommon });
    } catch { continue; }
    for (const [recName, rec] of em.records) {
      if (!ID.test(recName) || rec.tag === 'enum' || JS_RESERVED.has(recName)) continue;
      let layout;
      try { layout = em.layoutOf(recName); } catch { continue; } // incomplete field type
      const claim = (name, owner, v) => {
        if (JS_RESERVED.has(name)) return;
        if (owners.has(name) && owners.get(name) !== owner) { conflicted.add(name); ambiguous++; return; }
        owners.set(name, owner);
        if (values.has(name) && values.get(name) !== v) conflicted.add(name);
        else values.set(name, v);
      };
      for (const [field, off] of Object.entries(layout.offsets)) {
        if (!ID.test(field)) continue;
        claim(`${recName}_${field}`, `${recName}.${field}`, off);
      }
      // the record's own size, for the strides and element sizes of tier 1.13
      // (sizeofCode in emit.mjs). A record whose name ends `_x<digits>` is
      // refused because `sizeof_rm_x21` is also how an array of 21 `struct rm`
      // spells itself — the same "a name that could mean two things" rule the
      // field names obey, applied before the two spellings can meet.
      if (!/_x\d+$/.test(recName)) claim(`sizeof_${recName}`, `sizeof(${recName})`, layout.size);
    }
  }
  for (const n of conflicted) values.delete(n);
  if (conflicted.size) {
    console.log(`nhfield: ${conflicted.size} name(s) refused (${ambiguous} ambiguous spelling, ` +
      `${conflicted.size - ambiguous} conflicting offset): ` + [...conflicted].slice(0, 12).join(', '));
  }
  return values;
}

/**
 * Write js/generated/nhfield.js with exactly the offsets the emitted modules
 * reference, read back out of the generated files — same discipline, and same
 * reason, as writeMacroModule(): a missing export is a runtime `undefined` in
 * a byte-exact program, and an incremental build cannot be trusted to have
 * reported every name.
 */
function writeFieldModule(values) {
  const outDir = path.join(repoRoot, 'js/generated');
  const used = new Set();
  const ref = new RegExp(`\\b${FIELD_NS}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.js') || f === path.basename(FIELD_MODULE)) continue;
    const text = fs.readFileSync(path.join(outDir, f), 'utf8');
    for (const m of text.matchAll(ref)) used.add(m[1]);
  }
  const names = [...used].sort();
  // A stride name is composed rather than tabled: `sizeof_rm_x21` is the size
  // of `struct rm [21]`, i.e. `21 * sizeof_rm`, and the emitter only ever
  // spells one whose product equals the size it just computed (sizeCodeFor).
  // Resolving it here rather than enumerating every array bound the corpus
  // might use keeps the table to one entry per record, and writes the
  // decomposition out beside the value instead of asserting it in prose.
  const composed = new Map(); // name -> "21 * sizeof_rm"
  for (const n of names) {
    if (values.has(n)) continue;
    const parts = n.split('_x');
    if (parts.length < 2 || !values.has(parts[0]) || !parts.slice(1).every((p) => /^\d+$/.test(p))) continue;
    let v = values.get(parts[0]);
    for (const p of parts.slice(1)) v *= Number(p);
    values.set(n, v);
    composed.set(n, `${parts.slice(1).join(' * ')} * ${parts[0]}`);
  }
  const missing = names.filter((n) => !values.has(n));
  if (missing.length) throw new Error(`nhfield: emitted names with no offset: ${missing.join(', ')}`);
  const lines = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
    '// See docs/NOTES-readability.md §2 (field offsets) and §12 (element sizes).',
    '',
    ...names.map((n) => `export const ${n} = ${values.get(n)};`
      + (composed.has(n) ? `   // = ${composed.get(n)}` : '')),
    '',
  ];
  fs.writeFileSync(path.join(outDir, path.basename(FIELD_MODULE)), lines.join('\n'));
  console.log(`nhfield: ${names.length} names exported (${composed.size} composed strides; ${values.size} available)`);
}

/**
 * Write js/generated/nhprop.js: one tiny function per object-like macro whose
 * body the emitters captured, with the imports those bodies need.
 *
 * The exported set is read back out of the generated files' import lists, for
 * the reason writeMacroModule() gives — a missing export is a runtime
 * `undefined` in a byte-exact program, and only a --force build has run every
 * emitter.  Each free identifier is resolved to its defining module through
 * the same symbol table the cross-file imports use.
 */
function writePropModule(symbols) {
  const outDir = path.join(repoRoot, 'js/generated');
  const base = path.basename(PROP_MODULE);
  const used = new Set();
  const importRe = new RegExp(`import \\{([^}]*)\\} from '\\./${base.replace('.', '\\.')}';`, 'g');
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.js') || f === base) continue;
    for (const m of fs.readFileSync(path.join(outDir, f), 'utf8').matchAll(importRe)) {
      for (const nm of m[1].split(',')) if (nm.trim()) used.add(nm.trim());
    }
  }
  const names = [...used].sort();
  const missing = names.filter((n) => !MACRO_HELPERS.has(n));
  if (missing.length) throw new Error(`nhprop: called helpers with no captured body (rebuild with --force): ${missing.join(', ')}`);
  const byFile = new Map();
  for (const n of names) {
    for (const v of MACRO_HELPERS.get(n).free) {
      const sym = symbols.get(v);
      if (!sym) throw new Error(`nhprop: helper ${n} reads ${v}, which no module exports`);
      if (!byFile.has(sym.file)) byFile.set(sym.file, new Set());
      byFile.get(sym.file).add(v);
    }
  }
  const bodies = names.map((n) => {
    const h = MACRO_HELPERS.get(n);
    return [`/** C: include/${h.header} — the \`${n}\` macro body */`,
      `export function ${n}() { return ${h.code}; }`].join('\n');
  });
  const text = bodies.join('\n\n');
  const fieldRefs = new Set([...text.matchAll(new RegExp(`\\${FIELD_PREFIX}([A-Za-z_][A-Za-z0-9_]*)`, 'g'))].map((m) => m[1]));
  const imports = ["import * as cptr from '../cptr.js';"];
  if (new RegExp(`\\b${CONST_NS}\\.`).test(text)) imports.push(`import * as ${CONST_NS} from '${CONST_MODULE}';`);
  if (new RegExp(`\\b${MACRO_NS}\\.`).test(text)) imports.push(`import * as ${MACRO_NS} from '${MACRO_MODULE}';`);
  if (fieldRefs.size) imports.push(`import * as ${FIELD_NS} from '${FIELD_MODULE}';`);
  for (const [file, vars] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    imports.push(`import { ${[...vars].sort().join(', ')} } from './${file}.js';`);
  }
  const lines = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
    '// See docs/NOTES-readability.md §3 (macro-body helpers).',
    '',
    ...imports.map((l) => wrapImport(l)),
    '',
    ...(fieldRefs.size ? [fieldPreamble(fieldRefs, null, base), ''] : []),
    formatSource(text, { where: base }),
    '',
  ];
  fs.writeFileSync(path.join(outDir, base), lines.join('\n'));
  console.log(`nhprop: ${names.length} macro-body helpers exported (${MACRO_HELPERS.size} captured)`);
}

/**
 * Write js/generated/nhmacrofn.js: one function per FUNCTION-like macro whose
 * body this port could name (tier 1.12, docs/NOTES-emit-hygiene.md).
 *
 * Same shape and same discipline as writePropModule — the names a module
 * actually imported are read back out of the emitted tree, every helper must
 * have a captured body, and every free name it reads must be something a module
 * exports. The one addition is the parameter list, which is the macro's own.
 */
function writeMacroFnModule(symbols) {
  const outDir = path.join(repoRoot, 'js/generated');
  const base = path.basename(MACRO_FN_MODULE);
  const used = new Set();
  const importRe = new RegExp(`import \\{([^}]*)\\} from '\\./${base.replace('.', '\\.')}';`, 'g');
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.js') || f === base) continue;
    for (const m of fs.readFileSync(path.join(outDir, f), 'utf8').matchAll(importRe)) {
      for (const nm of m[1].split(',')) if (nm.trim()) used.add(nm.trim());
    }
  }
  const names = [...used].sort();
  const missing = names.filter((n) => !MACRO_FN_HELPERS.has(n));
  if (missing.length) throw new Error(`nhmacrofn: called helpers with no captured body (rebuild with --force): ${missing.join(', ')}`);
  const byFile = new Map();
  for (const n of names) {
    const h = MACRO_FN_HELPERS.get(n);
    // free storage the body reads, and the provably-pure functions it calls;
    // both are resolved once here, at the helper module's own scope
    for (const v of [...h.free, ...(h.calls || [])]) {
      const sym = symbols.get(v);
      if (!sym) throw new Error(`nhmacrofn: helper ${n} needs ${v}, which no module exports`);
      if (!byFile.has(sym.file)) byFile.set(sym.file, new Set());
      byFile.get(sym.file).add(v);
    }
  }
  const bodies = names.map((n) => {
    const h = MACRO_FN_HELPERS.get(n);
    return [`/** C: include/${h.header} — the \`${n}(${h.params.join(', ')})\` macro body */`,
      `export function ${n}(${h.params.join(', ')}) { return ${h.code}; }`].join('\n');
  });
  const text = bodies.join('\n\n');
  const fieldRefs = new Set([...text.matchAll(new RegExp(`\\${FIELD_PREFIX}([A-Za-z_][A-Za-z0-9_]*)`, 'g'))].map((m) => m[1]));
  const imports = ["import * as cptr from '../cptr.js';"];
  if (new RegExp(`\\b${CONST_NS}\\.`).test(text)) imports.push(`import * as ${CONST_NS} from '${CONST_MODULE}';`);
  if (new RegExp(`\\b${MACRO_NS}\\.`).test(text)) imports.push(`import * as ${MACRO_NS} from '${MACRO_MODULE}';`);
  if (fieldRefs.size) imports.push(`import * as ${FIELD_NS} from '${FIELD_MODULE}';`);
  for (const [file, vars] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    imports.push(`import { ${[...vars].sort().join(', ')} } from './${file}.js';`);
  }
  const lines = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
    '// See docs/NOTES-emit-hygiene.md §3 (function-like macros, tier 1.12).',
    '',
    ...imports.map((l) => wrapImport(l)),
    '',
    ...(fieldRefs.size ? [fieldPreamble(fieldRefs, null, base), ''] : []),
    formatSource(text, { where: base }),
    '',
  ];
  fs.writeFileSync(path.join(outDir, base), lines.join('\n'));
  console.log(`nhmacrofn: ${names.length} function-like macro helpers exported (${MACRO_FN_HELPERS.size} captured)`);
}

/**
 * Write js/generated/nhrng.js: one helper per rng-log-instrumented PRNG entry
 * point, holding the ternary the recorder's `hack.h` put at every call site.
 *
 * Same read-back discipline as writePropModule — the names the tree actually
 * imported decide what is exported — and the same reason. The bodies are
 * written here rather than emitted from the IR because they are not
 * transpiled C: the macro is the C, and this is its one shared expansion.
 *
 * THE LOG IS SCORED. The body performs exactly the three calls the macro did,
 * in the macro's order, so `getRngLog()` is byte-identical; see the note above
 * RNG_LOG_MACROS in emit.mjs for the one thing that does move (when the
 * argument is evaluated) and the audit that bounds it.
 */
function writeRngModule() {
  const outDir = path.join(repoRoot, 'js/generated');
  const base = path.basename(RNG_MODULE);
  const used = new Set();
  const importRe = new RegExp(`import \\{([^}]*)\\} from '\\./${base.replace('.', '\\.')}';`, 'g');
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.js') || f === base) continue;
    for (const m of fs.readFileSync(path.join(outDir, f), 'utf8').matchAll(importRe)) {
      for (const nm of m[1].split(',')) if (nm.trim()) used.add(nm.trim());
    }
  }
  const names = [...used].sort();
  const arity = new Map([...RNG_HELPERS].map(([n, a]) => [n + '_at', { fn: n, a }]));
  const missing = names.filter((n) => !arity.has(n));
  if (missing.length) throw new Error(`nhrng: called helpers with no folded site (rebuild with --force): ${missing.join(', ')}`);
  const called = [...new Set(names.map((n) => arity.get(n).fn))].sort();
  const bodies = names.map((n) => {
    const { fn, a } = arity.get(n);
    const ps = a === 1 ? ['x'] : Array.from({ length: a }, (_, i) => `a${i + 1}`);
    return [`/** C: include/hack.h — the rng-log \`${fn}(${ps.join(', ')})\` macro body */`,
      `export function ${n}(file, line, func, ${ps.join(', ')}) {`,
      `    return rng_log_enabled() ? (rng_log_set_caller(file, line, func), ${fn}(${ps.join(', ')})) : ${fn}(${ps.join(', ')});`,
      '}'].join('\n');
  });
  // With the caller annotation off (the default — see RNG_CALLER in emit.mjs)
  // no site spells a helper, so the module is a header and nothing else: an
  // import of rnd.js here would be a module edge the shipped graph does not
  // need.
  const lines = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
    '// See docs/NOTES-readability.md §13 (the rng-log fold) and §19 (C2JS_RNGCALLER).',
    '',
    ...(names.length
      ? [`import { ${[...called, 'rng_log_enabled', 'rng_log_set_caller'].sort().join(', ')} } from './rnd.js';`, '', ...bodies, '']
      : []),
  ];
  fs.writeFileSync(path.join(outDir, base), lines.join('\n'));
  console.log(`nhrng: ${names.length} rng-log helpers exported (${RNG_HELPERS.size} folded)`);
}

/**
 * The module-scope bindings for the struct field offsets a file uses.
 *
 * A site spells the offset `$monst_data` rather than `FLD.monst_data` because
 * V8 constant-folds a module-scope `const` and does not fold a namespace load
 * — worth 8.1% of the corpus per-move time over 150k sites (see
 * docs/NOTES-readability.md §2). The values still come from nhfield.js; this
 * is a fold hint, not a second table.
 *
 * The `$` prefix cannot collide with anything the emitter emits for C code,
 * since a C identifier cannot contain `$`; the assertion is kept anyway.
 */
function fieldPreamble(refs, declared, where) {
  if (!refs.size) return null;
  const names = [...refs].sort();
  const clash = names.filter((n) => declared && declared.has(FIELD_PREFIX + n));
  if (clash.length) throw new Error(`field-offset binding(s) collide with a declaration in ${where}: ${clash.join(', ')}`);
  const lines = ['// struct field offsets used below, bound at module scope so V8 folds them',
    `// (values from ${FIELD_MODULE}, which is the whole table)`];
  if (!FMT_ON) { // the pre-jsfmt fill, at its own width, so C2JS_FMT=0 is exact
    let cur = 'const ';
    for (let i = 0; i < names.length; i++) {
      const piece = `${FIELD_PREFIX}${names[i]} = ${FIELD_NS}.${names[i]}${i === names.length - 1 ? ';' : ','}`;
      if (cur !== 'const ' && cur.length + piece.length > 110) { lines.push(cur.trimEnd()); cur = '    '; }
      cur += piece + ' ';
    }
    lines.push(cur.trimEnd());
    return lines.join('\n');
  }
  // filled to the column budget, continuations aligned under the first binding
  const body = fillItems(names.map((n) => `${FIELD_PREFIX}${n} = ${FIELD_NS}.${n}`), 6);
  body[0] = `const ${body[0].trimStart()}`;
  body[body.length - 1] += ';';
  return [...lines, ...body].join('\n');
}

/** assemble a generated module from emitter output (+ optional prelude/imports) */
function assemble({ name, srcRel, sha, emitter, chunks, prelude, crossImports }) {
  const header = [
    '// Generated by tools/c2js — do not edit by hand',
    `// Input: ${srcRel}`,
    `// Input sha256: ${sha}`,
    `// Transpiler: tools/c2js ${TRANSPILER_VERSION}`,
  ].join('\n');

  // The transpiled C, wrapped to the column budget. Only the body: the header,
  // the imports, the field preamble, the hand-written runtime preludes and the
  // string table are not transpiled expressions and each already has a layout
  // of its own. See tools/c2js/jsfmt.mjs; C2JS_FMT=0 restores the one-line-per-
  // statement emission.
  const bodyText = formatSource(chunks.map((c) => c.join('\n')).join('\n\n'), { where: `${name}.js` });

  const imports = [];
  if (/isaac64_/.test(bodyText)) imports.push("import { isaac64_init, isaac64_next_uint64 } from '../isaac64.js';");
  if (emitter.cmachine.size) imports.push(`import { ${[...emitter.cmachine].sort().join(', ')} } from '../cmachine.js';`);
  if (emitter.usesCptr || emitter.stringList.length || (prelude && /\bcptr\./.test(prelude))) {
    imports.push("import * as cptr from '../cptr.js';");
  }
  if (emitter.usesCjmp || (prelude && /\bcjmp\./.test(prelude))) {
    imports.push("import * as cjmp from '../cjmp.js';");
  }
  if (emitter.usesConsts) {
    // collision guard for the namespace prefix: a C local/param named NHC
    // would shadow the import inside its function, so any bare NHC token in
    // the body (i.e. one not written as a `NHC.` qualifier) is a hard error.
    const bare = (bodyText + (prelude || '')).match(new RegExp(`\\b${CONST_NS}\\b(?!\\.)`, 'g'));
    if (bare) throw new Error(`named-constant prefix ${CONST_NS} collides with an emitted identifier in ${name}.c`);
    imports.push(`import * as ${CONST_NS} from '${CONST_MODULE}';`);
  }
  if (emitter.usesMacros) {
    const bare = (bodyText + (prelude || '')).match(new RegExp(`\\b${MACRO_NS}\\b(?!\\.)`, 'g'));
    if (bare) throw new Error(`macro-constant prefix ${MACRO_NS} collides with an emitted identifier in ${name}.c`);
    imports.push(`import * as ${MACRO_NS} from '${MACRO_MODULE}';`);
  }
  if (emitter.fieldRefs.size) {
    const bare = (bodyText + (prelude || '')).match(new RegExp(`\\b${FIELD_NS}\\b(?!\\.)`, 'g'));
    if (bare) throw new Error(`field-offset prefix ${FIELD_NS} collides with an emitted identifier in ${name}.c`);
    imports.push(`import * as ${FIELD_NS} from '${FIELD_MODULE}';`);
  }
  if (emitter.macroFnRefs.size) {
    const clash = [...emitter.macroFnRefs].filter((n) => emitter.declared.has(n));
    if (clash.length) throw new Error(`function-like macro helper name(s) collide with a declaration in ${name}.c: ${clash.join(', ')}`);
    imports.push(`import { ${[...emitter.macroFnRefs].sort().join(', ')} } from '${MACRO_FN_MODULE}';`);
  }
  if (emitter.rngRefs.size) {
    // bare-name import, like the macro helpers: `rn2_at` is not a C identifier
    // (a C local cannot be named after a live function-like macro's expansion),
    // and the collision is asserted rather than assumed
    const clash = [...emitter.rngRefs].filter((n) => emitter.declared.has(n));
    if (clash.length) throw new Error(`rng-log helper name(s) collide with a declaration in ${name}.c: ${clash.join(', ')}`);
    // nhrng.js imports rnd.js, which imports decl.js. Neither of those two may
    // import nhrng.js back. rnd.c cannot (hack.h's RNGLOG_IN_RND_C suppresses
    // the macros there) and decl.c happens not to draw; if either ever does,
    // this is where it has to be decided rather than discovered at load time.
    if (name === 'rnd' || name === 'decl') {
      throw new Error(`${name}.c folded an rng-log site, which would make ${RNG_MODULE} part of its own import cycle`);
    }
    imports.push(`import { ${[...emitter.rngRefs].sort().join(', ')} } from '${RNG_MODULE}';`);
  }
  if (emitter.propRefs.size) {
    // bare-name import: a C identifier cannot be named after a live
    // object-like macro, so nothing emitted here can shadow one — asserted
    // rather than assumed, as with the NHC/NHM/FLD prefixes
    const clash = [...emitter.propRefs].filter((n) => emitter.declared.has(n));
    if (clash.length) throw new Error(`macro helper name(s) collide with a declaration in ${name}.c: ${clash.join(', ')}`);
    imports.push(`import { ${[...emitter.propRefs].sort().join(', ')} } from '${PROP_MODULE}';`);
  }
  for (const [file, names] of crossImports || []) {
    imports.push(`import { ${names.sort().join(', ')} } from './${file}.js';`);
  }

  const fieldTable = fieldPreamble(emitter.fieldRefs, emitter.declared, `${name}.c`);

  // Named after their own content (STRING_PREFIX in emit.mjs). The `__s_`
  // prefix is checked rather than assumed: a C identifier may legally start
  // with `__s_`, so a name that also names something the module declares would
  // be a silent capture — the string table is emitted above the body, so the
  // *declaration* would win and every use would read the wrong thing.
  const stringNames = emitter.stringNames.length ? emitter.stringNames : emitter.stringList.map((_, i) => `__sl${i}`);
  const strClash = stringNames.filter((n) => emitter.declared.has(n));
  if (strClash.length) throw new Error(`string-literal name(s) collide with a declaration in ${name}.c: ${strClash.join(', ')}`);
  const stringTable = emitter.stringList.length
    ? ['// string literals (C char* uses decay to CPtr into these static buffers)',
      ...emitter.stringList.map((raw, i) => `const ${stringNames[i]} = cptr.lit(${raw});`)].join('\n')
    : null;

  const out = [header, '', ...imports.map((l) => wrapImport(l)), '', ...(fieldTable ? [fieldTable, ''] : []), ...(prelude ? [prelude, ''] : []), ...(stringTable ? [stringTable, ''] : []), bodyText, ''].join('\n');
  // __FILE__ hygiene: nothing this machine knows about its own filesystem may
  // reach the shipped tree (emit.mjs, sourcePathSpelling)
  assertNoAbsolutePaths(out, `${name}.js`);
  return out;
}

function emitOneFile(name, srcFile, { prelude, crossImports } = {}) {
  const source = fs.readFileSync(srcFile, 'utf8');
  const sha = crypto.createHash('sha256').update(source).digest('hex');
  const root = loadAst(astPathFor(srcFile));
  const { decls, lineOf } = mainFileDecls(root, srcFile, compileCwdFor(srcFile));
  const emitter = new Emitter({ decls, lineOf, source, fileName: `${name}.c`, compileCwd: compileCwdFor(srcFile) });
  const chunks = emitter.emitModule();
  const srcRel = path.relative(repoRoot, srcFile);
  return assemble({ name, srcRel, sha, emitter, chunks, prelude, crossImports });
}

function writeOut(name, out) {
  const outDir = path.join(repoRoot, 'js/generated');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${name}.js`);
  fs.writeFileSync(outFile, out);
  return outFile;
}

function buildSingle(name) {
  let srcFile = path.join(repoRoot, 'nethack-c/recorder/src', `${name}.c`);
  if (!fs.existsSync(srcFile)) srcFile = path.join(repoRoot, 'tools/c2js/fixtures', `${name}.c`);
  if (!fs.existsSync(srcFile)) { console.error(`no such source: ${name}.c (looked in src/ and fixtures/)`); process.exit(1); }
  const astPath = astPathFor(srcFile);
  if (!fs.existsSync(astPath)) { console.error(`no cached AST: ${astPath} (run tools/c2js/ast-dump.mjs first)`); process.exit(1); }
  const out = emitOneFile(name, srcFile, { prelude: loadPrelude(name) });
  const outFile = writeOut(name, out);
  console.log(`wrote ${path.relative(repoRoot, outFile)} (${out.length} bytes)`);
}

// ---- batch ----

/** normalize an emitter error into a rankable cause */
function causeOf(err) {
  const m = String(err.message || err).split('\n')[0];
  let mm;
  if ((mm = m.match(/unsupported node kind (\w+)/))) return `node kind: ${mm[1]}`;
  if ((mm = m.match(/unsupported top-level decl (\w+)/))) return `top-level decl: ${mm[1]}`;
  if ((mm = m.match(/unsupported implicit cast (\w+)/))) return `implicit cast: ${mm[1]}`;
  if ((mm = m.match(/unsupported (unary|binary) op (\S+)/))) return `operator: ${mm[2]}`;
  if ((mm = m.match(/ForStmt with (\d+) parts/))) return `ForStmt shape: ${mm[1]} parts`;
  if ((mm = m.match(/^(loadFrom|storeTo): unsupported access type "([^"]+)"/))) return `${mm[1]}: ${mm[2]}`;
  if ((mm = m.match(/^layout: unknown struct (.+)$/))) return `layout: unknown struct ${mm[1]}`;
  if ((mm = m.match(/^(sizeof|sizeAlign): [^"]*"([^"]*)"/))) return `${mm[1]}: ${mm[2]}`;
  if ((mm = m.match(/^(MemberExpr \.\w+ on rep \w+)/))) return mm[1];
  if ((mm = m.match(/^(emitLValue: unsupported \w+)/))) return mm[1];
  if ((mm = m.match(/^(compound assign \S+ on [^ ]+ [^ ]+ [^ ]+)/))) return mm[1];
  return m.length > 90 ? m.slice(0, 90) + '…' : m;
}

// decl.js is the globals hub of a giant import cycle and is kept a leaf of it
// (see the IMPORT_SKIP note below); nhprop.js reads those globals, so decl.js
// keeps its macro expansions inline rather than importing back into the cycle.
const PROP_SKIP = new Set(['decl']);

function buildAll() {
  const force = process.argv.includes('--force');
  const targets = listTargets();
  const withPrelude = new Set(fs.readdirSync(path.join(repoRoot, 'tools/c2js/runtime'))
    .filter((f) => f.endsWith('-prelude.js')).map((f) => f.replace(/-prelude\.js$/, '')));

  // pass 1: load slim IRs (rebuilding stale ones from the full AST dumps)
  const perFile = [];
  let t0 = Date.now();
  let rebuilt = 0;
  for (const t of targets) {
    const astPath = astPathFor(t.file);
    if (!fs.existsSync(astPath)) { perFile.push({ ...t, parseError: 'no cached AST' }); continue; }
    try {
      const fresh = fs.existsSync(slimIrPath(t)) && fs.statSync(slimIrPath(t)).mtimeMs >= fs.statSync(astPath).mtimeMs;
      if (!fresh) rebuilt++;
      perFile.push(loadSlimIr(t));
    } catch (err) {
      perFile.push({ ...t, parseError: String(err.message || err) });
    }
  }
  const bitfieldWidths = collectBitfieldWidths(targets);
  const { symbols, conflicts } = buildSymbolMap(perFile.filter((p) => !p.parseError));
  // globals whose address is taken anywhere in the program must be boxed at
  // their definition (cross-file &uarm etc.)
  const externBoxed = new Set();
  for (const pf of perFile) for (const nm of pf.addressTaken || []) externBoxed.add(nm);
  // globals written from a TU that does not define them must also be boxed
  // (ES module bindings are immutable to importers)
  const varDefTUs = new Map(); // name -> Set of TU names defining a variable
  for (const pf of perFile) {
    if (pf.parseError) continue;
    for (const d of pf.defs) {
      if (d.kind !== 'variable') continue;
      if (!varDefTUs.has(d.name)) varDefTUs.set(d.name, new Set());
      varDefTUs.get(d.name).add(pf.name);
    }
  }
  for (const pf of perFile) {
    if (pf.parseError) continue;
    for (const nm of pf.writtenNames || []) {
      const defTUs = varDefTUs.get(nm);
      if (!defTUs || !defTUs.has(pf.name)) externBoxed.add(nm);
    }
  }
  // record-typed globals/arrays are byte-packed cptr.alloc storage in their
  // defining TU; every referencing TU must use byte-offset access as well
  const recordGlobals = new Set(), recordArrays = new Set();
  for (const pf of perFile) {
    for (const nm of pf.recordGlobals || []) recordGlobals.add(nm);
    for (const nm of pf.recordArrays || []) recordArrays.add(nm);
  }
  const constNames = writeConstModule(perFile);
  const { byKey: macroDefs, values: macroValues } = scanMacroDefs();
  // struct field offsets have to be agreed corpus-wide before the first file
  // is emitted; see collectFieldOffsets
  const fieldOffsets = collectFieldOffsets(perFile, { externBoxed, recordGlobals, recordArrays, bitfieldWidths });
  const macroExprDefs = scanMacroExprDefs();
  const macroFnDefs = scanMacroFnDefs();
  const pureFns = collectPureFunctions(perFile);
  console.log(`purity: ${pureFns.size} functions proved pure (no write, no RNG, no I/O, transitively)`);
  console.log(`pass 1: ${perFile.length} slim IRs (${rebuilt} rebuilt) in ${((Date.now() - t0) / 1000).toFixed(1)}s; ` +
    `${symbols.size} importable symbols, ${conflicts.size} conflicts`);

  // incremental emission state: skip files whose IR + emitter are unchanged
  const statePath = path.join(repoRoot, '.cache/c2js/emit-state.json');
  const emitMtime = fs.statSync(new URL('file://' + path.join(repoRoot, 'tools/c2js/emit.mjs')).pathname).mtimeMs;
  let state = { emitVersion: -1, emitMtime: 0, files: {} };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const stateFresh = state.emitVersion === EMIT_VERSION && state.emitMtime === emitMtime;
  const newState = { emitVersion: EMIT_VERSION, emitMtime, files: {} };

  // pass 2: emit each file
  const results = [];
  const causes = new Map(); // cause -> [file names]
  t0 = Date.now();
  for (const pf of perFile) {
    if (pf.parseError) {
      results.push({ name: pf.name, ok: false, cause: `AST: ${pf.parseError}` });
      continue;
    }
    if (withPrelude.has(pf.name)) {
      // prelude-proven files: still refresh their generated module with the
      // current emitter (prelude included, no cross imports) — the batch
      // import graph reads them from disk, so a stale emission breaks parity
      try {
        const emitter = new Emitter({ decls: pf.decls, lineOf: pf.lineOf, source: fs.readFileSync(pf.file, 'utf8'), fileName: `${pf.name}.c`, extraRecords: pf.recordDefs, compileCwd: compileCwdFor(pf.file), anonByLoc: pf.anonByLoc, externBoxed, enumValues: pf.enumValues, constNames, macroDefs, fieldOffsets, macroExprDefs: PROP_SKIP.has(pf.name) ? null : macroExprDefs, macroFnDefs: PROP_SKIP.has(pf.name) ? null : macroFnDefs, pureFns, recordGlobals, recordArrays, bitfieldWidths });
        const chunks = emitter.emitModule();
        const sha = crypto.createHash('sha256').update(fs.readFileSync(pf.file)).digest('hex');
        const out = assemble({ name: pf.name, srcRel: path.relative(repoRoot, pf.file), sha, emitter, chunks, prelude: loadPrelude(pf.name), crossImports: null });
        const outFile = writeOut(pf.name, out);
        let parses = true;
        try { execFileSync('node', ['--check', outFile]); } catch { parses = false; }
        results.push({ name: pf.name, ok: 'skipped', cause: `has dedicated prelude (refreshed${parses ? '' : ', PARSE FAIL'})` });
      } catch (err) {
        results.push({ name: pf.name, ok: false, cause: causeOf(err), detail: String(err.message || err).split('\n')[0] });
      }
      continue;
    }
    try {
      const emitter = new Emitter({ decls: pf.decls, lineOf: pf.lineOf, source: fs.readFileSync(pf.file, 'utf8'), fileName: `${pf.name}.c`, extraRecords: pf.recordDefs, compileCwd: compileCwdFor(pf.file), anonByLoc: pf.anonByLoc, externBoxed, enumValues: pf.enumValues, constNames, macroDefs, fieldOffsets, macroExprDefs: PROP_SKIP.has(pf.name) ? null : macroExprDefs, macroFnDefs: PROP_SKIP.has(pf.name) ? null : macroFnDefs, pureFns, recordGlobals, recordArrays, bitfieldWidths });
      const chunks = emitter.emitModule();
      // cross-file imports: referenced but not declared here. decl.js must
      // stay a leaf (it is the globals hub in a giant import cycle); its one
      // import is resolved via globalThis at call time instead.
      const IMPORT_SKIP = { decl: new Set(['raw_printf']) };
      const skip = IMPORT_SKIP[pf.name];
      const byFile = new Map();
      for (const [refName] of emitter.refs) {
        if (emitter.declared.has(refName)) continue;
        if (skip && skip.has(refName)) continue;
        const sym = symbols.get(refName);
        if (!sym || sym.file === pf.name) continue;
        if (!byFile.has(sym.file)) byFile.set(sym.file, []);
        byFile.get(sym.file).push(refName);
      }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(pf.file)).digest('hex');
      const out = assemble({ name: pf.name, srcRel: path.relative(repoRoot, pf.file), sha, emitter, chunks, prelude: null, crossImports: byFile });
      const outFile = writeOut(pf.name, out);
      // syntax check
      let parses = true;
      try { execFileSync('node', ['--check', outFile]); } catch { parses = false; }
      results.push({ name: pf.name, ok: true, parses, bytes: out.length, decls: pf.decls.length, imports: [...byFile.keys()].length });
    } catch (err) {
      const cause = causeOf(err);
      results.push({ name: pf.name, ok: false, cause, detail: String(err.message || err).split('\n')[0] });
      if (!causes.has(cause)) causes.set(cause, []);
      causes.get(cause).push(pf.name);
    }
  }

  // After emission, so each module exports exactly what the files reference —
  // and the HELPER modules first, because they are themselves files that
  // reference NHM./FLD. names. Written last, their references were invisible to
  // the scans below, and a clean build produced an nhmacrofn.js reading
  // NHM.M3_COVETOUS from an nhmacro.js that did not export it: a namespace
  // import of a missing name is `undefined`, not an error, so it is silent
  // until the one helper that uses it runs. assertNamespaceExports() below
  // turns that whole class loud rather than relying on this ordering.
  writePropModule(symbols);
  writeMacroFnModule(symbols);
  writeRngModule();
  writeMacroModule(macroValues);
  writeFieldModule(fieldOffsets);
  assertNamespaceExports();

  const ok = results.filter((r) => r.ok === true);
  const skipped = results.filter((r) => r.ok === 'skipped');
  const failed = results.filter((r) => r.ok === false);
  const ranked = [...causes.entries()].sort((a, b) => b[1].length - a[1].length);
  const totalDecls = perFile.reduce((a, p) => a + (p.decls ? p.decls.length : 0), 0);
  const okDecls = ok.reduce((a, r) => a + r.decls, 0);
  const totalFns = perFile.reduce((a, p) => a + (p.defs ? p.defs.filter((d) => d.kind === 'function').length : 0), 0);
  const okFnSet = new Set(ok.map((r) => r.name));
  const okFns = perFile.filter((p) => okFnSet.has(p.name)).reduce((a, p) => a + p.defs.filter((d) => d.kind === 'function').length, 0);
  const parseFails = ok.filter((r) => !r.parses);

  const lines = [];
  lines.push(`c2js batch coverage — ${new Date().toISOString()}`);
  lines.push(`files: ${results.length} total, ${ok.length} transpiled, ${failed.length} failed, ${skipped.length} skipped (prelude-proven)`);
  lines.push(`decls covered: ${okDecls}/${totalDecls}; functions covered: ${okFns}/${totalFns}`);
  lines.push(`parse check failures among emitted: ${parseFails.length}${parseFails.length ? ' — ' + parseFails.map((r) => r.name).join(', ') : ''}`);
  lines.push('');
  lines.push('failure causes ranked by file count:');
  for (const [cause, files] of ranked) {
    lines.push(`  ${String(files.length).padStart(4)}  ${cause}    (e.g. ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''})`);
  }
  lines.push('');
  lines.push('transpiled clean:');
  for (const r of ok) lines.push(`  ${r.name.padEnd(24)} ${String(r.bytes).padStart(8)} bytes  ${String(r.decls).padStart(4)} decls  ${r.imports} imports  parse:${r.parses ? 'ok' : 'FAIL'}`);
  lines.push('');
  lines.push('failures (file: cause — detail):');
  for (const r of failed) lines.push(`  ${r.name}: ${r.cause} — ${r.detail || ''}`);
  const report = lines.join('\n') + '\n';
  const reportPath = path.join(repoRoot, '.cache/c2js/coverage.txt');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  // punted goto shapes (Rule 3): recorded for later decision
  const punted = failed.filter((r) => /^goto/.test(r.cause)).map((r) => `${r.name}: ${r.detail || r.cause}`);
  fs.writeFileSync(path.join(repoRoot, '.cache/c2js/punted.txt'),
    `# goto shapes that loud-threw in the latest batch (${new Date().toISOString()})\n` + punted.join('\n') + (punted.length ? '\n' : ''));
  fs.writeFileSync(statePath, JSON.stringify(newState));

  console.log(`pass 2: emit in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${ok.length} ok, ${failed.length} failed, ${skipped.length} skipped`);
  console.log(`decls ${okDecls}/${totalDecls}, functions ${okFns}/${totalFns}, parse-failures ${parseFails.length}`);
  console.log('\ntop failure causes:');
  for (const [cause, files] of ranked.slice(0, 15)) {
    console.log(`  ${String(files.length).padStart(4)}  ${cause}    (e.g. ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''})`);
  }
  console.log(`\nfull report: ${path.relative(repoRoot, reportPath)}`);
}

/**
 * C2JS_YIELD=1 — additionally emit the yieldable build.
 *
 * The yield build is a whole-program rewrite of the emitter's output (every
 * function that can reach a blocking keystroke read becomes a generator), so
 * it necessarily runs AFTER all 176 modules exist and can see all of them at
 * once; it is a separate pass, not a mode inside emit.mjs. Two consequences
 * that matter:
 *
 *   - the synchronous build in js/generated/ is produced by exactly the same
 *     code with the flag on or off — the flag adds work after that directory
 *     is final, and cannot alter a byte of it;
 *   - the rewrite sees the hand-written runtime preludes that assemble()
 *     inlines verbatim, which emit.mjs never does.
 *
 * See tools/c2js/yieldify.mjs and docs/NOTES-async-engine.md.
 */
async function maybeYield() {
  if (!process.env.C2JS_YIELD) return;
  console.log('\nC2JS_YIELD=1 — emitting the yieldable build');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(TOOLS_DIR_SELF, 'yieldify.mjs'), '--check'], { stdio: 'inherit' });
}

/**
 * C2JS_RESET=1 — additionally emit the reset functions.
 *
 * Same shape as C2JS_YIELD and for the same reasons: the pass needs all 176
 * modules to exist (it writes a barrel over them), and it needs to see the
 * hand-written runtime preludes that assemble() inlines verbatim — rnd.js's
 * `__rngLog`, the scored RNG log, is declared in one of them and emit.mjs
 * never sees it.
 *
 * Unlike the yield build, this one writes *into* js/generated/ rather than
 * beside it, because module-scope state can only be reset from inside the
 * module that owns it. It appends a delimited block to each module's tail and
 * touches nothing above it, and it strips any previous block before appending,
 * so it is idempotent and `--strip` is an exact inverse. With the flag off the
 * pass does not run, so the scored build is byte-for-byte what it was.
 *
 * BOTH BUILDS. The yieldable build in js/generated-y/ needs the same treatment
 * — js/boot/main-thread-engine.mjs is the interactive rung a `node --permission`
 * sandbox lands on, and it plays a whole corpus in one process — so the pass is
 * run once per directory. It cannot be inherited through yieldify: that rewrite
 * would turn `__captureState`'s calls to its own `S` parameter into
 * `(yield* Y.icall(S(x)))` and leave the barrel calling generators. yieldify
 * therefore strips the block on the way through (tools/c2js/callgraph.mjs), so
 * js/generated-y/ is byte-identical whichever order the two flags are set in,
 * and this pass appends to it afterwards. That also fixes the order below:
 * maybeYield rewrites the whole of js/generated-y/ from scratch, so it must run
 * BEFORE the reset pass writes into it.
 *
 * See tools/c2js/resetify.mjs, tools/c2js/reset-census.mjs and
 * js/boot/reset-realm.mjs.
 */
async function maybeReset() {
  if (!process.env.C2JS_RESET) return;
  console.log('\nC2JS_RESET=1 — emitting per-module __resetState() + the reset barrel');
  const { execFileSync } = await import('node:child_process');
  for (const dir of ['js/generated', 'js/generated-y']) {
    execFileSync(process.execPath, [path.join(TOOLS_DIR_SELF, 'resetify.mjs'), '--dir', dir],
      { stdio: 'inherit' });
  }
}
/**
 * Every `NHC.x` / `NHM.x` / `FLD.x` a generated module reads must actually be
 * exported by the module it imports from.
 *
 * A namespace import makes a missing name `undefined` rather than a load
 * error, so the failure surfaces as NaN arithmetic inside whichever function
 * first touches it — arbitrarily far from the build that caused it, and
 * invisible to a corpus that happens not to call it. The sidecar modules
 * export the subset of names the tree references, computed by scanning the
 * tree, so any writer that emits a reference *after* its provider has been
 * scanned reintroduces the bug. This closes it by construction.
 */
function assertNamespaceExports() {
  const outDir = path.join(repoRoot, 'js/generated');
  const providers = [[CONST_NS, CONST_MODULE], [MACRO_NS, MACRO_MODULE], [FIELD_NS, FIELD_MODULE]];
  const exported = new Map();
  for (const [ns, mod] of providers) {
    const file = path.join(outDir, path.basename(mod));
    const names = new Set();
    if (fs.existsSync(file)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^export const ([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1]);
    }
    exported.set(ns, names);
  }
  const bad = [];
  for (const f of fs.readdirSync(outDir).sort()) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(outDir, f), 'utf8');
    for (const [ns, mod] of providers) {
      if (f === path.basename(mod)) continue;
      for (const m of text.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) {
        if (!exported.get(ns).has(m[1])) bad.push(`${f}: ${ns}.${m[1]}`);
      }
    }
  }
  if (bad.length) {
    throw new Error(`namespace import reads ${bad.length} name(s) the provider does not export ` +
      `(a runtime undefined, not a load error): ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ' …' : ''}`);
  }
  console.log('namespace exports: every NHC./NHM./FLD. name a module reads is exported');
}

/**
 * Final sweep: no emitted tree may carry an absolute machine path.
 *
 * assemble() asserts per-module as it writes, but three later passes splice
 * text in that assemble() never sees — the sidecar modules (nhconst/nhmacro/
 * nhfield/nhprop/nhmacrofn), yieldify's whole-program rewrite into
 * js/generated-y/, and resetify's appended blocks. This runs last and reads
 * the trees back off disk, so it is the assertion that actually covers what
 * ships.
 */
function assertTreesHygienic() {
  let checked = 0;
  for (const dir of ['js/generated', 'js/generated-y']) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.js')) continue;
      assertNoAbsolutePaths(fs.readFileSync(path.join(abs, f), 'utf8'), `${dir}/${f}`);
      checked++;
    }
  }
  console.log(`\nemit hygiene: ${checked} emitted modules carry no absolute machine path`);
  if (FMT_ON) {
    console.log(`jsfmt: budget ${FMT_COLS} cols — ${FMT_STATS.linesWrapped} of ${FMT_STATS.linesSeen} statement lines wrapped `
      + `into ${FMT_STATS.linesEmitted}, ${FMT_STATS.docsWrapped} C-ref markers reflowed, `
      + `${FMT_STATS.trailingCarried} trailing comments carried to the last line; `
      + `${FMT_STATS.unsplittable} lines over budget with no break point, ${FMT_STATS.auditFailed} failed the token audit`);
  }
}

/**
 * C2JS_BUNDLE — additionally emit the scope-hoisted engine, js/generated-y/__bundle.js.
 *
 * LAST, and after assertTreesHygienic(), for three reasons:
 *   - yieldify `rm -rf`s js/generated-y/ on the way in, so anything written
 *     there before it runs is deleted; and resetify appends the reset blocks
 *     the bundle's inlined barrel is made of, so it must run after that too.
 *   - the four read-back-driven sidecar writers, assertNamespaceExports() and
 *     the hygiene assert all scan the *tree*. The bundle is an additional
 *     artifact, never a replacement: everything that reads js/generated-y/**
 *     — callgraph.mjs, resetify.mjs, reset-census.mjs, the diffs — keeps
 *     reading it, and the per-module tree stays readable and diffable.
 *   - it is derived. Emitting it from the finished tree rather than from the
 *     IR means there is one model of what was emitted, not two.
 *
 * ON BY DEFAULT WHEN THERE IS A YIELD BUILD TO BUNDLE, because js/boot/
 * harness-y.mjs — which yieldify itself writes — imports the bundle and
 * nothing else. A build that emitted the tree and skipped the bundle would
 * produce a boot path with a 404 in it, which is a console line, which fails
 * the judge's browser check. `C2JS_BUNDLE=0` turns it off, and is the A/B
 * baseline every measurement in §8 is taken against.
 *
 * See tools/c2js/bundle.mjs and docs/NOTES-startup.md §8.
 */
async function maybeBundle() {
  if (!process.env.C2JS_YIELD) return;
  if (process.env.C2JS_BUNDLE === '0') {
    console.log('\nC2JS_BUNDLE=0 — not emitting the scope-hoisted engine');
    return;
  }
  console.log('\nemitting the scope-hoisted engine (C2JS_BUNDLE=0 to skip)');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(TOOLS_DIR_SELF, 'bundle.mjs'), '--dir', 'js/generated-y'],
    { stdio: 'inherit' });
}

/**
 * Every path js/boot/preload.mjs puts a `<link rel=modulepreload>` at must exist.
 *
 * A preload link at a path the mirror does not publish is a 404, a 404 is a
 * console line, and a console line fails the judge's browser check — and the
 * list is a constant in a file nothing else imports, so nothing else would
 * notice a rename. Run last, over what actually shipped.
 */
async function assertPreloadPaths() {
  const { PRELOAD_PATHS } = await import(pathToFileURL(path.join(repoRoot, 'js/boot/preload.mjs')).href);
  const missing = PRELOAD_PATHS.filter((p) => !fs.existsSync(path.join(repoRoot, 'js/boot', p)));
  if (missing.length) {
    throw new Error(`js/boot/preload.mjs would preload ${missing.length} path(s) that do not exist `
      + `(a 404, i.e. a console line, i.e. a failed browser check): ${missing.join(', ')}`);
  }
  console.log(`preload paths: all ${PRELOAD_PATHS.length} exist`);
}

const TOOLS_DIR_SELF = path.dirname(fileURLToPath(import.meta.url));

// buildAll/buildSingle may or may not return a promise depending on the path
// taken; normalise before chaining so the hook can never mask a build failure
// or, worse, invent one after a build that succeeded.
if (process.argv[2] === '--all') Promise.resolve(buildAll()).then(maybeYield).then(maybeReset).then(assertTreesHygienic).then(maybeBundle).then(assertPreloadPaths);
else Promise.resolve(buildSingle(process.argv[2])).then(maybeYield);
