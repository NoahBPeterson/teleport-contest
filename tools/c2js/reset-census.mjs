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
        // A FLAT OBJECT DESTRUCTURING — `const { a, b, c } = <init>` — binds
        // names this walk *can* read, so it does. The emitter produces none;
        // hand-written modules do (js/lua-js/bridge.mjs's `export const {
        // nhRandom, mathRandom, percent, d, shuffle } = makeNhlib(rn2)`), and
        // reporting five real bindings as one unreadable line would push the
        // whole module into the unknown pile for no reason. Every name gets the
        // SAME initializer and therefore the same classification, which is
        // correct: they are five properties of one value, and a strategy that
        // is right for the value is right for each of them.
        //
        // Deliberately flat only: no renaming (`{ a: b }`), no defaults
        // (`{ a = 1 }`), no rest (`...r`), no nesting, no array pattern. Each of
        // those changes what the bindings ARE, and a scanner that guessed would
        // be guessing about the one thing this file exists to be exact about.
        // Anything else falls through to the loud path below.
        if (!bound && t2(tokens, m) === '{') {
            const names = flatPatternNames(tokens, m);
            if (names) {
                let p = names.close + 1;
                let initStart = null, initEnd = null;
                if (tokens[p]?.v === '=') {
                    initStart = p + 1;
                    let d = 0;
                    p++;
                    while (p < tokens.length) {
                        const q = tokens[p];
                        if (q.t === 'punc') {
                            if (q.v === '(' || q.v === '[' || q.v === '{') d++;
                            else if (q.v === ')' || q.v === ']' || q.v === '}') d--;
                            else if (d === 0 && q.v === ';') break;
                        }
                        p++;
                    }
                    initEnd = p;
                }
                const initToks = initStart === null ? [] : tokens.slice(initStart, initEnd);
                const init = initToks.length ? src.slice(initToks[0].i, initToks[initToks.length - 1].j) : null;
                for (const nt of names.toks) moduleNames.add(nt.v);
                for (const nt of names.toks) {
                    const cls = classify(initToks, moduleNames);
                    decls.push({
                        file, name: nt.v, declKw, exported,
                        kind: cls.kind, strategy: STRATEGY[cls.kind], detail: cls.detail,
                        init, line: lineOf(src, nt.i), declTok: exported ? k - 1 : k,
                        pattern: true,
                    });
                    if (cls.kind === KIND.OTHER) {
                        warnings.push({ file, kind: 'unclassified', detail: `${nt.v} = ${trunc(init)}` });
                    }
                }
                k = p;
                continue;
            }
        }

        // ANY OTHER DESTRUCTURING declaration — renamed, defaulted, nested, or
        // an array pattern — binds names at module scope that this walk cannot
        // read, and the c2js emitter produces none. Two things then have to be
        // true, and neither was:
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

const t2 = (tokens, i) => (tokens[i] && tokens[i].t === 'punc' ? tokens[i].v : null);

/**
 * The identifiers of a FLAT object pattern starting at the `{` at `i`.
 * @returns {{toks: Array, close: number}|null} null when it is not flat
 */
function flatPatternNames(tokens, i) {
    const toks = [];
    let j = i + 1;
    for (;;) {
        const t = tokens[j];
        if (!t) return null;
        if (t.t === 'punc' && t.v === '}') return { toks, close: j };
        if (t.t !== 'id') return null;                 // string key, `...`, nesting
        if (t.v === 'true' || t.v === 'false' || t.v === 'null') return null;
        toks.push(t);
        j++;
        const sep = tokens[j];
        if (!sep || sep.t !== 'punc') return null;
        if (sep.v === ',') { j++; continue; }
        if (sep.v === '}') return { toks, close: j };
        return null;                                   // `:` rename, `=` default
    }
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
    // NHC.FOO / NHM.BAR / FLD.baz — a named constant from one of the merged
    // constant modules. FLD is the struct field offset table (roadmap 1.11):
    // a module binds the offsets it uses as `const $rec_field = FLD.rec_field`
    // so V8 folds them, and those bindings are as immutable as the others.
    if (first.t === 'id' && txt(1) === '.' && toks.length === 3
        && (first.v === 'NHC' || first.v === 'NHM' || first.v === 'FLD')) {
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

// ------------------------------------------------- hand-written directories --
//
// `--dir` can be pointed at a directory the EMITTER DOES NOT WRITE, and
// js/lua-js (roadmap 1.10) is the first one that matters: nine hand-written
// modules that live in the same realm as the graph, hold their own state, and
// therefore have to be put back between games exactly as js/generated and
// js/cptr.js are. Their reset is hand-written (js/lua-js/registry.mjs's
// __resetState) rather than emitted, so nothing derives their list — which is
// the situation this whole file exists to refuse.
//
// So the list is *signed*. Every declaration the scanner cannot show to be an
// immutable primitive needs an entry below saying which it is:
//
//   strategy: 'none'  — it cannot change, and `why` says how that is known
//   strategy: 'hand'  — it can, and `reset` names the function that puts it back
//
// The check runs both ways. A declaration with no entry is reported as
// UNSIGNED and counts as unclassified, so adding module state without saying
// what happens to it fails the census. An entry naming a declaration that is no
// longer there is reported as STALE, so an audit is a diff rather than a
// memory — the same property RUNTIME_STATE has.
//
// What is signed 'none' here is not a promise that the value is deeply frozen.
// It is that nothing in this tree writes it: the tables below are read by the
// ports and by the bridge, never assigned into, and the frozen ones cannot be
// even if somebody tried.
export const HAND_WRITTEN = {
    'js/lua-js': {
        why: 'the Lua->JS script ports; state reset by js/lua-js/registry.mjs '
            + '__resetState(), driven from js/boot/reset-realm.mjs',
        modules: {
            'bridge.mjs': {
                cstrCache: { strategy: 'hand', reset: 'bridge.__resetState: cleared',
                    why: 'interns cptr.lit() buffers by string, and a buffer object is what addr() gives an id to — the §3 identity hazard. Cleared so game 2 re-interns exactly as a fresh realm would' },
                L: { strategy: 'hand', reset: 'bridge.__resetState: nulled',
                    why: 'the port-owned lua_State, allocated out of the previous game\'s heap through its realloc' },
                activeL: { strategy: 'hand', reset: 'bridge.__resetState: nulled',
                    why: 'cursor at the state a library port is currently marshalling into; points into a spent game' },
                callPool: { strategy: 'hand', reset: 'bridge.__resetState: nulled',
                    why: 'LuaValues minted during the entry-point call in progress; there is no call in progress in a fresh realm' },
                keptValues: { strategy: 'hand', reset: 'bridge.__resetState: replaced with []',
                    why: 'values held past the call that made them (themerms\' one escaping selection). Dropped, not freed: free() decrements a refcount in a C heap the barrel is about to overwrite' },
                desObjectResult: { strategy: 'hand', reset: 'bridge.__resetState: false',
                    why: 'whether des.object() should take lspo_object\'s return value; scoped to withDesObjectResult(), so true here means a game ended inside it' },
                COORD_FIELDS: { strategy: 'none', why: 'six field names, read by the marshaller' },
                DES_FUNCS: { strategy: 'none', why: 'the 34 des binding names, read to build `des`' },
                SELECTION_FUNCS: { strategy: 'none', why: 'the 24 selection binding names' },
                OBJ_FUNCS: { strategy: 'none', why: 'the obj binding names' },
                RESULT_FIELDS: { strategy: 'none', why: 'which fields a call\'s result table carries, by binding name; read only' },
                DES_VALUE_FUNCS: { strategy: 'none', why: 'the one des binding that takes a value rather than a table; a Set built from a literal and only ever queried' },
                des: { strategy: 'none', why: 'Object.freeze of a table of arrow functions — the des DSL handed to every port' },
                selection: { strategy: 'none', why: 'Object.freeze, same shape' },
                obj: { strategy: 'none', why: 'Object.freeze, same shape' },
                string: { strategy: 'none', why: 'Object.freeze; one method, string.match, for dat/tut-1.lua' },
                uTable: { strategy: 'none', why: 'Object.freeze of getters that READ u through cptr on every access — the state they expose is the game\'s, and the barrel resets it' },
                nhc: { strategy: 'none', why: 'Object.freeze({COLNO, ROWNO})' },
                luaTable: { strategy: 'none', why: 'the LuaValue prototype\'s method table: functions only, assigned once at module scope, never written' },
                api: { strategy: 'none', why: 'Object.freeze of the frozen tables above plus functions; what every port receives' },
                nhRandom: { strategy: 'none', why: 'nhlib helper closed over rn2; a function' },
                mathRandom: { strategy: 'none', why: 'as nhRandom' },
                percent: { strategy: 'none', why: 'as nhRandom' },
                d: { strategy: 'none', why: 'as nhRandom' },
                shuffle: { strategy: 'none', why: 'as nhRandom' },
            },
            'interp-state.mjs': {
                candidates: { strategy: 'hand', reset: 'interp-state.__resetState: emptied in place',
                    why: 'the last 8 sizeof(LG) allocations, i.e. pointers into the previous game\'s heap' },
                installed: { strategy: 'hand', reset: 'interp-state.__resetState: false',
                    why: 'THE ONE THAT BITES. The probe wraps globalThis.realloc, and harness.mjs installs a fresh one per game; left true, game 2 never re-wraps and every read-back port throws' },
                portState: { strategy: 'hand', reset: 'interp-state.__resetState: nulled',
                    why: 'identity of the bridge\'s own lua_State, so the probe can exclude it' },
            },
            'nhlib-fns.mjs': {
                tutorial_blacklist_commands: { strategy: 'none',
                    why: 'nhlib.lua\'s own table, ported verbatim; read by tutorial_command_blacklist()' },
            },
            'readback.mjs': {
                TYPE_NAMES: { strategy: 'none', why: 'lua_type() number -> name, for the dump' },
            },
            'registry.mjs': {
                PORTS: { strategy: 'none', why: 'script name -> port function, built once from the imports' },
                READBACK: { strategy: 'none', why: 'as PORTS, for the two read-back scripts' },
                LIBRARY: { strategy: 'none', why: 'as PORTS, for the three library scripts' },
                LEVEL_PROBE: { strategy: 'none', why: 'C2JS_LUA_LEVELPROBE split once. env() reads process.env, which is per-PROCESS: a fresh realm in this process computes the same value' },
                QUEST_PROBE: { strategy: 'none', why: 'as LEVEL_PROBE' },
                QUEST_PROBE_MSGIDS: { strategy: 'none', why: 'five message ids, read by the probe' },
                OBJ_FIELDS: { strategy: 'none', why: 'struct obj offsets for the level fingerprint; read only' },
                MON_FIELDS: { strategy: 'none', why: 'struct monst offsets, ditto' },
                TRAP_FIELDS: { strategy: 'none', why: 'struct trap offsets, ditto' },
                ENGR_FIELDS: { strategy: 'none', why: 'struct engr offsets, ditto' },
                ENGR_TEXTS: { strategy: 'none', why: 'the two engraving text offsets' },
                loads: { strategy: 'hand', reset: 'registry.__resetState: emptied IN PLACE',
                    why: 'the per-load trace. Emptied rather than replaced because closeTrace() and tools/lua-oracle.mjs hold this exact array — and js/boot/reset-realm.mjs slices it on the way out for the same reason it slices the RNG log' },
                unportedLua: { strategy: 'hand', reset: 'registry.__resetState: cleared',
                    why: 'the "which .lua still reached the parser" tally; a per-game census that must not accumulate across games' },
                armed: { strategy: 'hand', reset: 'registry.__resetState: nulled',
                    why: 'the load record waiting for a level fingerprint; holds a record from a game that is over' },
                levelProbed: { strategy: 'hand', reset: 'registry.__resetState: false',
                    why: 'whether the C2JS_LUA_LEVELPROBE levels were built; game 2 must build its own' },
                questProbed: { strategy: 'hand', reset: 'registry.__resetState: false', why: 'as levelProbed' },
            },
        },
    },
};

/** Kinds whose `const` form needs no sign-off: an immutable primitive. */
const PRIMITIVE_KINDS = new Set([KIND.NUM, KIND.BIGINT, KIND.BOOLSTR, KIND.CONSTREF]);

/**
 * Check a hand-written directory's declarations against its signed manifest.
 *
 * @returns {{signed: Array, unsigned: Array, stale: Array}|null} null when the
 *          directory has no manifest, i.e. it is emitter output and derives.
 */
export function signOff(dirRel, modules) {
    const entry = HAND_WRITTEN[dirRel];
    if (!entry) return null;
    const signed = [], unsigned = [], stale = [];
    const used = new Set();
    for (const [file, decls] of modules) {
        const table = entry.modules[file] || {};
        for (const d of decls) {
            const e = table[d.name];
            if (e) { signed.push({ file, name: d.name, ...e }); used.add(file + ':' + d.name); continue; }
            if (d.declKw === 'const' && PRIMITIVE_KINDS.has(d.kind)) continue;
            unsigned.push({ file, name: d.name, kind: d.kind, init: d.init });
        }
    }
    for (const [file, table] of Object.entries(entry.modules)) {
        for (const name of Object.keys(table)) {
            if (!used.has(file + ':' + name)) stale.push({ file, name });
        }
    }
    return { signed, unsigned, stale };
}

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
    // Count what resetify will actually emit, not what the strategy column
    // suggests: planFor() drops a `const` scalar, whose binding cannot be
    // rebound and whose contents are a number. Since roadmap 1.11 there are
    // 13k of those — the per-module `const $rec_field = FLD.rec_field` fold
    // hints — and counting them here would have made the plan look 2.6x
    // bigger than the 1,395 bindings resetify reports.
    let resettable = 0;
    for (const [, decls] of modules) {
        for (const d of decls) {
            if (d.kind === KIND.LIT || d.kind === KIND.OTHER) continue;
            if (d.declKw !== 'const' || STRATEGY[d.kind] === 'snapshot') resettable++;
        }
    }
    const ignored = (byKind.get(KIND.LIT) || { count: 0 }).count;

    // A hand-written directory does not derive; it signs. Anything the manifest
    // accounts for stops being unclassified, and anything it fails to account
    // for becomes unclassified even when the scanner had a shape for it.
    const sign = signOff(dirRel, modules);
    let unknown = (byKind.get(KIND.OTHER) || { count: 0 }).count;
    if (sign) {
        const signedOther = new Set(sign.signed.map((s) => s.file + ':' + s.name));
        let stillUnknown = 0;
        for (const [f, decls] of modules) {
            for (const d of decls) if (d.kind === KIND.OTHER && !signedOther.has(f + ':' + d.name)) stillUnknown++;
        }
        unknown = stillUnknown + sign.unsigned.length + sign.stale.length;
    }
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
    if (sign) {
        const signedKey = new Set(sign.signed.map((s) => s.file + ':' + s.name));
        W(`\n--- SIGNED hand-written state (${sign.signed.length}) — ${dirRel} ---\n`);
        W(`    ${HAND_WRITTEN[dirRel].why}\n`);
        for (const s of sign.signed) {
            W(`  ${s.file}: ${s.name} [${s.strategy}]\n      ${s.why}\n`
                + (s.reset ? `      -> ${s.reset}\n` : ''));
        }
        if (sign.unsigned.length) {
            W(`\n--- UNSIGNED (${sign.unsigned.length}) — module state with nothing said about it ---\n`);
            for (const u of sign.unsigned) W(`  ${u.file}: ${u.name} [${u.kind}] = ${trunc(u.init, 60)}\n`);
        }
        if (sign.stale.length) {
            W(`\n--- STALE (${sign.stale.length}) — signed off but no longer declared ---\n`);
            for (const s of sign.stale) W(`  ${s.file}: ${s.name}\n`);
        }
        const un = warnings.filter((w) => w.kind === 'unclassified'
            && !signedKey.has(w.file + ':' + String(w.detail).split(' =')[0]));
        if (un.length) {
            W(`\n--- UNCLASSIFIED (${un.length}) — the scanner could not read these at all ---\n`);
            for (const w of un) W(`  ${w.file}: ${w.detail}\n`);
        }
    } else if (opts.unknown || unknown) {
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
