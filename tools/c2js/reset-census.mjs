#!/usr/bin/env node
// reset-census.mjs — enumerate every piece of module-level mutable state in the
// transpiled build, and say how each one is put back.
//
// WHY THIS EXISTS. Resetting a module graph in place is only as good as the
// list of things it resets, and that list cannot be written by hand: it is
// ~1,200 declarations spread over 176 machine-generated modules that change
// every time the transpiler does. So the list is *derived* from the emitted
// source, by the same analysis that tools/c2js/resetify.mjs uses to emit the
// reset functions. Census and emitter cannot disagree, because they are the
// same code — the same reason tools/c2js/color-census.mjs shares
// callgraph.mjs with yieldify.mjs.
//
// WHAT COUNTS AS STATE. A top-level binding is state if a second game could
// observe what the first game left in it. That is not the same as "is a `let`":
//   - `let n = 0`                      state: reassigned by game code
//   - `const t = cptr.alloc(48)`       state: the binding is const, the BYTES
//                                      are the C array and are written all game
//   - `const s = cptr.bytes("...")`    state: a C `char[]` initializer, which C
//                                      is entitled to write into (and does —
//                                      NetHack builds strings in them)
//   - `const p = cptr.lit("...")`      NOT state, on the argument below
//   - `function f() {}`                not state
//
// THE LITERAL ARGUMENT, stated plainly because it is 95% of the declarations.
// `cptr.lit(s)` is how a C *string literal* is emitted. Writing through a
// string literal is undefined behaviour in C and NetHack does not do it, so
// these buffers are read-only in practice and restoring 24k of them on every
// reset would be pure cost. "In practice" is not proof, so the claim is
// *checked* rather than assumed: --verify-lits runs a real session and reports
// any lit buffer whose bytes moved. The reset ships without lit restoration
// only because that check comes back empty.
//
// USAGE
//   node tools/c2js/reset-census.mjs                 # summary + plan
//   node tools/c2js/reset-census.mjs --by-kind       # every declaration
//   node tools/c2js/reset-census.mjs --module decl   # one module
//   node tools/c2js/reset-census.mjs --unknown       # only what it can't class
//   node tools/c2js/reset-census.mjs --verify-lits SESSION
//   node tools/c2js/reset-census.mjs --json out.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenize } from './jslex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(HERE, '..', '..');
const GEN_DIR = path.join(repoRoot, 'js/generated');

// ---------------------------------------------------------------- classes ---
//
// Every class carries its own reset strategy. `snapshot` means "copy the bytes
// at capture, write them back at reset"; `rebind` means "remember the value,
// assign it back"; `none` means the analysis has proved nothing can change.

export const KIND = {
    NUM: 'num',             // let x = 0 / 3.5 / -1
    BIGINT: 'bigint',       // let x = 0n
    BOOLSTR: 'boolstr',     // let x = true / "s"
    NULLPTR: 'nullptr',     // let p = null
    CONSTREF: 'constref',   // let x = NHC.FOO / NHM.BAR
    ARENA: 'arena',         // cptr.alloc(...) / cptr.malloc(...)  -> {buf,off}
    BYTES: 'bytes',         // cptr.bytes("...")                   -> Uint8Array
    TYPED: 'typed',         // new Uint8Array(n) / new Int32Array(n) / ...
    IIFE2D: 'iife2d',       // (function(){...})() row-view table
    ARRAYFROM: 'arrayfrom', // Array.from({length:n}, () => <row-view table>)
    ARRAYLIT: 'arraylit',   // [ ... ] literal
    BOX: 'box',             // cptr.box(v)
    LIT: 'lit',             // cptr.lit("...")  — immutable, see header
    DECAY: 'decay',         // cptr.decay(x) — a view onto something else's bytes
    ALIAS: 'alias',         // = <another module-level identifier>
    OTHER: 'other',         // anything the analysis will not guess about
};

// How each kind is put back. Kept as data so the emitter and the census can
// never drift on it.
export const STRATEGY = {
    [KIND.NUM]: 'rebind', [KIND.BIGINT]: 'rebind', [KIND.BOOLSTR]: 'rebind',
    [KIND.NULLPTR]: 'rebind', [KIND.CONSTREF]: 'rebind', [KIND.ALIAS]: 'rebind',
    [KIND.ARENA]: 'snapshot', [KIND.BYTES]: 'snapshot', [KIND.TYPED]: 'snapshot',
    [KIND.IIFE2D]: 'snapshot', [KIND.ARRAYLIT]: 'snapshot', [KIND.BOX]: 'snapshot',
    [KIND.ARRAYFROM]: 'snapshot',
    [KIND.DECAY]: 'snapshot',
    [KIND.LIT]: 'none',
    [KIND.OTHER]: 'unknown',
};

const TYPED_CTORS = new Set(['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
    'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray']);

// ------------------------------------------------------------- the scanner --

/**
 * Every top-level `let`/`const`/`var` declarator in `src`, classified.
 *
 * Depth-0 only: a declaration inside a function body is that call's own state
 * and dies with the call. Depth is tracked over ( [ { alike, so an initializer
 * that spans lines (the 2-D IIFE tables do) cannot be mistaken for a new
 * top-level statement — which a line-based scanner would get wrong, and which
 * is the whole reason this uses the lexer.
 *
 * @returns {{decls: Array, warnings: Array}}
 */
export function analyzeModule(src, opts = {}) {
    const file = opts.file || '<src>';
    const { tokens, oddities } = tokenize(src);
    const decls = [];
    const warnings = oddities.map((o) => ({ file, kind: 'lexer', detail: String(o.what || o) }));

    let depth = 0;
    // Names bound at module scope, so an initializer that is a bare identifier
    // can be recognised as an alias rather than an unknown.
    const moduleNames = new Set();

    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.t === 'punc') {
            if (t.v === '(' || t.v === '[' || t.v === '{') { depth++; continue; }
            if (t.v === ')' || t.v === ']' || t.v === '}') { depth--; continue; }
            continue;
        }
        if (depth !== 0 || t.t !== 'id') continue;
        if (t.v !== 'let' && t.v !== 'const' && t.v !== 'var') continue;
        // `export let x` — the `export` is the token before.
        const exported = tokens[k - 1]?.v === 'export';
        // `for (let i = ...)` cannot appear at depth 0 for our purposes.
        const declKw = t.v;

        // Walk the declarator list: NAME = <init> [, NAME = <init>]* ;
        let m = k + 1;
        let bound = false;
        for (;;) {
            const nameTok = tokens[m];
            if (!nameTok || nameTok.t !== 'id') break;
            const name = nameTok.v;
            moduleNames.add(name);
            let initStart = null, initEnd = null;
            let d = 0, p = m + 1;
            if (tokens[p]?.v === '=') {
                initStart = p + 1;
                p++;
                while (p < tokens.length) {
                    const q = tokens[p];
                    if (q.t === 'punc') {
                        if (q.v === '(' || q.v === '[' || q.v === '{') d++;
                        else if (q.v === ')' || q.v === ']' || q.v === '}') d--;
                        else if (d === 0 && (q.v === ',' || q.v === ';')) break;
                    }
                    p++;
                }
                initEnd = p;
            } else {
                // `let x;` — declared without an initializer.
                while (p < tokens.length && !(tokens[p].t === 'punc' && (tokens[p].v === ',' || tokens[p].v === ';'))) p++;
            }
            const initToks = initStart === null ? [] : tokens.slice(initStart, initEnd);
            const cls = classify(initToks, moduleNames);
            decls.push({
                file, name, declKw, exported,
                kind: cls.kind, strategy: STRATEGY[cls.kind],
                detail: cls.detail,
                init: initToks.length ? src.slice(initToks[0].i, initToks[initToks.length - 1].j) : null,
                line: lineOf(src, nameTok.i),
                // token index of the whole declaration, for the emitter
                declTok: exported ? k - 1 : k,
            });
            if (cls.kind === KIND.OTHER) {
                warnings.push({ file, kind: 'unclassified', detail: `${name} = ${trunc(decls[decls.length - 1].init)}` });
            }
            bound = true;
            if (tokens[p]?.v === ',') { m = p + 1; continue; }
            break;
        }
        // A DESTRUCTURING declaration — `const { a, b } = f()` or
        // `const [x] = ...` — binds names at module scope that this walk cannot
        // read, and the c2js emitter produces none, which is why nothing has
        // ever met one. Two things then have to be true, and neither was:
        //
        //   1. It must be LOUD. Left as it is, such a declaration's bindings
        //      are simply absent from the reset — the one failure mode this
        //      whole design refuses, since `S()` throws on a shape it cannot
        //      snapshot precisely so that nothing is ever silently skipped.
        //      Reported as unclassified, so tools/c2js/resetify.mjs refuses to
        //      emit a block for the module rather than emitting a short one.
        //   2. It must not desynchronise the SCAN. `k = m` used to step past
        //      the opening `{` without the depth counter seeing it, so its `}`
        //      drove depth to -1 and every function body in the rest of the
        //      file then looked like module scope. Found on the unmerged
        //      lua-port branch, where one `export const { nhRandom, ... } =
        //      makeNhlib(rn2)` turned 25 function-locals in js/lua-js/bridge.mjs
        //      into phantom top-level state.
        if (!bound) {
            warnings.push({ file, kind: 'unclassified',
                detail: `${declKw} <destructuring> at line ${lineOf(src, t.i)} — `
                    + 'the bindings it creates cannot be enumerated by this scan' });
            continue;   // leave k on the keyword: the next iteration counts `{`
        }
        k = m;
    }
    return { decls, warnings };
}

function classify(toks, moduleNames) {
    if (toks.length === 0) return { kind: KIND.OTHER, detail: 'no initializer' };
    const first = toks[0];
    const txt = (i) => toks[i]?.v;

    // cptr.<f>(...)
    if (first.v === 'cptr' && txt(1) === '.') {
        const f = txt(2);
        if (f === 'alloc' || f === 'malloc') return { kind: KIND.ARENA, detail: f };
        if (f === 'bytes') return { kind: KIND.BYTES, detail: f };
        if (f === 'lit') return { kind: KIND.LIT, detail: f };
        if (f === 'box' || f === 'boxProp') return { kind: KIND.BOX, detail: f };
        if (f === 'decay') return { kind: KIND.DECAY, detail: f };
        return { kind: KIND.OTHER, detail: 'cptr.' + f };
    }
    // new <TypedArray>(...)
    if (first.v === 'new' && TYPED_CTORS.has(txt(1))) return { kind: KIND.TYPED, detail: txt(1) };
    // (function () { ... })()  — the row-view table idiom
    if (first.v === '(' && txt(1) === 'function') return { kind: KIND.IIFE2D, detail: 'iife' };
    // [ ... ]
    if (first.v === '[') return { kind: KIND.ARRAYLIT, detail: `len~${toks.length}` };
    // Array.from({length: n}, () => ...) — the 3-D table idiom (vision.js's
    // could_see is the only instance today). Snapshotting is generic over
    // nesting, so this needs no special handling beyond being recognised.
    if (first.v === 'Array' && txt(1) === '.' && txt(2) === 'from') {
        return { kind: KIND.ARRAYFROM, detail: 'Array.from' };
    }
    // null
    if (first.v === 'null' && toks.length === 1) return { kind: KIND.NULLPTR, detail: 'null' };
    // number / BigInt: a literal, or a constant fold the emitter left in
    // source form (`(171 - 1) | 0`). Any all-numeric expression qualifies —
    // it re-evaluates to the same value, and it is snapshotted by value anyway.
    const NUM_OPS = new Set(['-', '+', '*', '/', '%', '(', ')', '|', '&', '^', '~', '<<', '>>', '>>>']);
    if (toks.every((t) => t.t === 'num' || (t.t === 'punc' && NUM_OPS.has(t.v)))) {
        const isBig = toks.some((t) => t.t === 'num' && /n$/.test(t.v));
        return { kind: isBig ? KIND.BIGINT : KIND.NUM, detail: toks.map((t) => t.v).join('') };
    }
    if (toks.length === 1 && first.t === 'str') return { kind: KIND.BOOLSTR, detail: 'string' };
    if (toks.length === 1 && (first.v === 'true' || first.v === 'false' || first.v === 'undefined')) {
        return { kind: KIND.BOOLSTR, detail: first.v };
    }
    // NHC.FOO / NHM.BAR — a named constant from the merged constant modules.
    if (first.t === 'id' && txt(1) === '.' && toks.length === 3
        && (first.v === 'NHC' || first.v === 'NHM')) {
        return { kind: KIND.CONSTREF, detail: `${first.v}.${txt(2)}` };
    }
    // A bare reference to another module-level binding.
    if (toks.length === 1 && first.t === 'id' && moduleNames.has(first.v)) {
        return { kind: KIND.ALIAS, detail: first.v };
    }
    return { kind: KIND.OTHER, detail: toks.slice(0, 6).map((t) => t.v).join(' ') };
}

function lineOf(src, off) {
    let n = 1;
    for (let i = 0; i < off; i++) if (src.charCodeAt(i) === 10) n++;
    return n;
}
function trunc(s, n = 90) { return s && s.length > n ? s.slice(0, n - 3) + '...' : String(s); }

// ------------------------------------------------- the pass's own output ----
//
// tools/c2js/resetify.mjs appends a delimited block to the tail of every
// stateful module. The delimiters live HERE, in the census, rather than beside
// the code that writes them, because three passes have to agree on them and
// only one of them writes:
//
//   - resetify strips before appending, which is what makes it idempotent and
//     `--strip` an exact inverse;
//   - the census strips before counting, or a reset build reports its own
//     `__c2js_rs` bindings as state;
//   - tools/c2js/callgraph.mjs strips before scanning, or yieldify colours
//     `__captureState`'s calls to its `S` parameter and emits reset functions
//     that are generators.
//
// This module is the one all three already import.

/** resetify's barrel; machine-written, and not itself a stateful module. */
export const RESET_BARREL = '__reset.js';
export const RESET_BEGIN = '// --- BEGIN c2js reset block (tools/c2js/resetify.mjs) — do not edit ---';
export const RESET_END = '// --- END c2js reset block ---';

/** Drop resetify's appended block, if this build has one. */
export function stripResetBlock(src) {
    const i = src.indexOf('\n' + RESET_BEGIN);
    if (i < 0) return src;
    const j = src.indexOf(RESET_END, i);
    if (j < 0) throw new Error('reset block has a BEGIN with no END — refusing to guess');
    return src.slice(0, i) + src.slice(j + RESET_END.length).replace(/^\n/, '');
}

// --------------------------------------------------------------- the sweep --

/** Analyze every generated module. @returns {{modules: Map, warnings: Array}} */
export function censusGenerated(dir = GEN_DIR) {
    const modules = new Map();
    const warnings = [];
    for (const f of fs.readdirSync(dir).sort()) {
        // .mjs too: the census is also how a directory that is NOT js/generated
        // gets scouted before it joins the reset (the unmerged lua-port branch's
        // js/lua-js is .mjs). The barrel is this pass's own output, not state.
        if (!/\.m?js$/.test(f) || f === RESET_BARREL) continue;
        // Stripped, so a reset build censuses the same as the build it came
        // from. Without this the census counts the block's own
        // `let __c2js_rs = null` as state — 146 phantom null pointers, one per
        // stateful module, in the report that is supposed to BE the ground
        // truth. tools/c2js/resetify.mjs always analysed the stripped source,
        // so nothing was ever emitted wrong; only the report was.
        const src = stripResetBlock(fs.readFileSync(path.join(dir, f), 'utf8'));
        const r = analyzeModule(src, { file: f });
        modules.set(f, r.decls);
        warnings.push(...r.warnings);
    }
    return { modules, warnings };
}

// The hand-written runtime the generated graph sits on. These are NOT rewritten
// by the emitter — they are reset by hand, in the module that owns them — so
// the census's job here is to make sure the hand-written list stays complete.
// Each entry says where the reset lives, so an audit is a diff, not a memory.
export const RUNTIME_STATE = [
    { file: 'js/cptr.js', name: '__bufIds', kind: 'identity',
      why: 'buffer -> base-id map behind addr(); ids reach Lua string-hash seeds (generated/lstate.js), math.random seeding (lmathlib.js) and table slot placement (ltable.js), so they are parity-observable',
      reset: 'cptr.__resetState: replaced with a fresh WeakMap, then the pre-capture assignment prefix replayed' },
    { file: 'js/cptr.js', name: '__nextBufId', kind: 'identity',
      why: 'the counter those ids come from',
      reset: 'cptr.__resetState: restored to its captured value (measured: still 1 after graph evaluation)' },
    { file: 'js/cptr.js', name: '__ptrRegistry', kind: 'identity',
      why: 'append-only; a stored pointer\'s id IS its index, so a second game must start numbering where evaluation left off, not where the first game did',
      reset: 'cptr.__resetState: truncated to its captured length' },
    { file: 'js/cptr.js', name: '__intPtrs', kind: 'identity',
      why: 'bit-pattern -> sentinel object; the objects are compared by identity',
      reset: 'cptr.__resetState: cleared' },
    { file: 'js/cptr.js', name: '__fds', kind: 'state', why: 'standalone fd table',
      reset: 'cptr.__resetState: cleared' },
    { file: 'js/cptr.js', name: '__nextFd', kind: 'identity', why: 'fd number allocator',
      reset: 'cptr.__resetState: restored to 100' },
    { file: 'js/cptr.js', name: '__fdHooks', kind: 'state',
      why: 'closure over the previous run\'s VFS; also a retention leak',
      reset: 'cptr.__resetState: nulled' },
    { file: 'js/cptr.js', name: '__fmtCache', kind: 'content-keyed cache',
      why: 'key is the decoded format string, value is compileFormat(key) which reads only the key and module constants and is never mutated after insert; eviction is a wholesale clear, so it can only change timing',
      reset: 'cptr.__resetState: cleared anyway — 78 entries on a real session, and matching a fresh realm exactly is worth more than rebuilding them' },
    { file: 'js/cptr.js', name: '__FMT_RE', kind: 'harmless',
      why: 'a /g regexp carries lastIndex, but compileFormat sets it to 0 before every use',
      reset: 'none needed' },
    { file: 'js/boot/harness.mjs', name: '__segCounter', kind: 'identity',
      why: 'incremented per boot; its value is currently never read',
      reset: 'none needed — flagged so it is not made live without a reset' },
    { file: 'js/data-nethackdir/index.mjs', name: 'decoded', kind: 'content-keyed cache',
      why: 'filename -> decoded bytes of an immutable base64 table; the single consumer (harness.mjs:172) slices before handing them out, so no game can write through it',
      reset: 'none needed — and this module is deliberately shared across forks too (isolation.mjs SHARED)' },
    { file: 'js/boot/posix-ere.mjs', name: '(none)', kind: 'harmless',
      why: 'ereCompile/ereBracket are pure functions of the pattern string; there is no memo table in this module. The regcomp cache is harness.mjs\'s __regexps, which is a per-call local',
      reset: 'none needed' },
    { file: 'js/isaac64.js', name: '(none)', kind: 'harmless',
      why: 'every function takes ctx; the ISAAC64 state lives in the caller\'s object',
      reset: 'none needed' },
    { file: 'js/generated/rnd.js', name: '__rngLog',
      kind: 'state (inlined from tools/c2js/runtime/rnd-prelude.js)',
      why: 'the scored RNG log; harness.mjs reads it through getRngLog()',
      reset: 'emitted __resetState — the post-pass sees it because it reads the emitted module, which is where the prelude has already been inlined' },
];

// ------------------------------------------------------------------- CLI ----

function summarize(modules) {
    const byKind = new Map();
    let total = 0;
    for (const decls of modules.values()) {
        for (const d of decls) {
            const e = byKind.get(d.kind) || { count: 0, let: 0, const: 0, modules: new Set() };
            e.count++; e[d.declKw === 'var' ? 'let' : d.declKw]++; e.modules.add(d.file);
            byKind.set(d.kind, e);
            total++;
        }
    }
    return { byKind, total };
}

async function main(argv) {
    const opts = { byKind: false, module: null, unknown: false, json: null, verifyLits: null, dir: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--by-kind') opts.byKind = true;
        else if (a === '--unknown') opts.unknown = true;
        else if (a === '--module') opts.module = argv[++i];
        else if (a === '--json') opts.json = argv[++i];
        else if (a === '--dir') opts.dir = argv[++i];
        else if (a.startsWith('--dir=')) opts.dir = a.slice(6);
        else if (a === '--verify-lits') opts.verifyLits = argv[++i] || 'seed8000';
        else throw new Error('unknown argument: ' + a);
    }

    if (opts.verifyLits) return verifyLits(opts.verifyLits);

    // `--dir` takes any directory of modules, absolute or repo-relative. It is
    // how a directory that does not exist on this branch yet gets scouted:
    // point it at a checkout of one and read the UNCLASSIFIED list, which is
    // exactly the work that directory would add to the reset.
    const dirRel = opts.dir || 'js/generated';
    const dirAbs = path.isAbsolute(dirRel) ? dirRel : path.join(repoRoot, dirRel);
    const { modules, warnings } = censusGenerated(dirAbs);
    const { byKind, total } = summarize(modules);

    const W = process.stdout.write.bind(process.stdout);
    W(`${dirRel}: ${modules.size} modules, ${total} top-level declarations\n\n`);
    W('kind        strategy   count    let  const  modules\n');
    W('----------  --------  ------  -----  -----  -------\n');
    const order = [...byKind.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [kind, e] of order) {
        W(kind.padEnd(10) + '  ' + String(STRATEGY[kind]).padEnd(8) + '  '
            + String(e.count).padStart(6) + '  ' + String(e.let).padStart(5) + '  '
            + String(e.const).padStart(5) + '  ' + String(e.modules.size).padStart(7) + '\n');
    }
    const resettable = order.filter(([k]) => STRATEGY[k] !== 'none' && STRATEGY[k] !== 'unknown')
        .reduce((n, [, e]) => n + e.count, 0);
    const ignored = (byKind.get(KIND.LIT) || { count: 0 }).count;
    const unknown = (byKind.get(KIND.OTHER) || { count: 0 }).count;
    W(`\nreset plan: ${resettable} declarations to put back, ${ignored} immutable literals to leave alone`
        + (unknown ? `, ${unknown} UNCLASSIFIED\n` : '\n'));

    if (opts.module) {
        const key = opts.module.endsWith('.js') ? opts.module : opts.module + '.js';
        const decls = modules.get(key);
        if (!decls) throw new Error('no such module: ' + key);
        W(`\n${key}\n`);
        for (const d of decls) {
            if (d.kind === KIND.LIT) continue;
            W(`  ${String(d.line).padStart(5)}  ${d.declKw.padEnd(5)} ${d.kind.padEnd(9)} `
                + `${d.strategy.padEnd(8)} ${d.name} = ${trunc(d.init, 60)}\n`);
        }
    }
    if (opts.byKind) {
        for (const [kind] of order) {
            if (kind === KIND.LIT) continue;
            W(`\n--- ${kind} (${byKind.get(kind).count}) ---\n`);
            for (const [f, decls] of modules) {
                for (const d of decls) if (d.kind === kind) W(`  ${f}:${d.line} ${d.name} = ${trunc(d.init, 70)}\n`);
            }
        }
    }
    if (opts.unknown || unknown) {
        const un = warnings.filter((w) => w.kind === 'unclassified');
        if (un.length) {
            W(`\n--- UNCLASSIFIED (${un.length}) — these must be resolved before the emitter is trusted ---\n`);
            for (const w of un) W(`  ${w.file}: ${w.detail}\n`);
        }
    }
    const lex = warnings.filter((w) => w.kind === 'lexer');
    if (lex.length) W(`\nlexer oddities: ${lex.length} (first: ${lex[0].detail})\n`);

    W(`\n--- hand-written runtime (${RUNTIME_STATE.length} entries; not emitter-driven) ---\n`);
    for (const r of RUNTIME_STATE) {
        W(`  ${r.file}: ${r.name} [${r.kind}]\n      ${r.why}\n      -> ${r.reset}\n`);
    }

    if (opts.json) {
        fs.writeFileSync(opts.json, JSON.stringify({
            total, resettable, ignored, unknown,
            byKind: Object.fromEntries([...byKind].map(([k, e]) => [k, { count: e.count, let: e.let, const: e.const, modules: e.modules.size }])),
            modules: Object.fromEntries([...modules].map(([f, d]) => [f, d.filter((x) => x.kind !== KIND.LIT)])),
            runtime: RUNTIME_STATE,
        }, null, 2));
    }
    return unknown === 0 ? 0 : 1;
}

/**
 * Run a real session and report any `cptr.lit()` buffer whose bytes moved.
 *
 * This is the evidence for the one thing the census asserts rather than
 * derives. It hooks lit() at load time (no source is modified), records every
 * buffer it hands out together with a copy of its bytes, plays a session, and
 * compares. An empty report is what licenses the emitter to skip 24k
 * declarations; a non-empty one would mean they have to be snapshotted too.
 */
async function verifyLits(sessionSpec) {
    const { registerHooks } = await import('node:module');
    const CPTR = path.join(repoRoot, 'js/cptr.js');
    const PROBE = `
const __litWatch = [];
export function __litWatchStart() { __litWatch.length = 0; return __litWatch; }
export function __litWatchCheck() {
  const bad = [];
  for (const e of __litWatch) {
    const b = e.buf;
    if (b.length !== e.snap.length) { bad.push({ s: e.s, why: 'length' }); continue; }
    for (let i = 0; i < b.length; i++) if (b[i] !== e.snap[i]) { bad.push({ s: e.s, why: 'byte ' + i + ': ' + e.snap[i] + ' -> ' + b[i] }); break; }
  }
  return { watched: __litWatch.length, bad };
}
const __litOrig = lit;
`;
    registerHooks({
        load(url, context, nextLoad) {
            const r = nextLoad(url, context);
            if (!url.startsWith(pathToFileURL(CPTR).href)) return r;
            let src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
            // Record every lit() buffer alongside a copy of its bytes.
            src = src.replace(
                'export function lit(s) {',
                'export function lit(s) { const __r = __litImpl(s); __litWatch.push({ s, buf: __r.buf, snap: __r.buf.slice() }); return __r; }\nfunction __litImpl(s) {');
            return { ...r, source: src + PROBE, shortCircuit: true };
        },
    });

    const { installBrowserGlobals } = await import(pathToFileURL(path.join(repoRoot, 'js/boot/browser-env.mjs')).href);
    installBrowserGlobals();
    const cptr = await import(pathToFileURL(CPTR).href);
    const { runBootGame } = await import(pathToFileURL(path.join(repoRoot, 'js/boot/harness.mjs')).href);

    const dirs = ['sessions', 'sessions-extra'];
    let file = null;
    for (const d of dirs) {
        for (const f of fs.readdirSync(path.join(repoRoot, d))) {
            if (f.startsWith(sessionSpec) && f.endsWith('.session.json')) file = path.join(repoRoot, d, f);
        }
    }
    if (!file) throw new Error('no session matching ' + sessionSpec);
    const { normalizeSession } = await import(pathToFileURL(path.join(repoRoot, 'frozen/session_loader.mjs')).href);
    const segs = normalizeSession(JSON.parse(fs.readFileSync(file, 'utf8'))).segments;

    const storage = new Map();
    const handle = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        get length() { return storage.size; },
        key: () => null,
    };
    // Only the first segment: a second segment in this un-forked graph would
    // replay into spent globals, which is not what is being measured here.
    const s = segs[0];
    await runBootGame({ seed: s.seed, datetime: s.datetime, nethackrc: s.nethackrc || '', moves: s.moves || '', storage: handle });

    const { watched, bad } = cptr.__litWatchCheck();
    process.stdout.write(`lit buffers watched: ${watched}\n`);
    process.stdout.write(`written through:     ${bad.length}\n`);
    for (const b of bad.slice(0, 40)) process.stdout.write(`  ${JSON.stringify(b.s).slice(0, 70)}  ${b.why}\n`);
    if (bad.length > 40) process.stdout.write(`  ... and ${bad.length - 40} more\n`);
    return bad.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    process.exitCode = await main(process.argv.slice(2));
}
