#!/usr/bin/env node
// bundle.mjs — one request instead of one hundred and eighty.
//
// WHAT THIS IS FOR, IN ONE NUMBER. The mirror's edge charges 12–16 ms of
// serialized work per request, whatever the request is — measured with a
// control, 180 cache-busted copies of a 1.9 KB file (50 KB on the wire) cost
// 2.1–2.9 s (docs/NOTES-startup.md §6.3). The engine tree is 180 modules. That
// is two seconds of somebody else's CDN on a budget the judge measures in
// three, and unlike parse time it does not shrink when the machine is fast.
// §2.5 refused bundling on a 61 ms parse argument measured on loopback; §8
// overturns it. This pass is §8.
//
// WHAT IT PRODUCES. A scope-hoisted concatenation of the reachable tree, in
// **ESM evaluation order**, as an ADDITIONAL artifact — `__bundle.js` beside
// the per-module tree, which stays exactly as it is. Everything that reads the
// tree (callgraph.mjs, resetify.mjs, reset-census.mjs, yieldify.mjs, the
// diffs, the notes) keeps reading the tree; only the four dynamic-import sites
// in js/boot/ load the bundle.
//
// WHY EVALUATION ORDER IS THE LOAD-BEARING PART. Every `cptr.lit()` and
// `cptr.alloc()` at module top level appends to js/cptr.js's pointer registry,
// and a pointer id is that registry's index. The Lua VM seeds string hashes
// from pointer ids, so the order in which module top-level initialisers run is
// parity-observable — the same reason resetify.mjs's barrel imports the entry
// bare and first, and the same reason isolation.mjs exists. So the modules are
// concatenated in the order a real `import('./unixmain.js')` evaluates them:
// depth-first, post-order, following each module's static imports in source
// order. Within a module, statement order is untouched.
//
// WHAT STAYS OUTSIDE, AND WHY
//   - `../cptr.js` — the pointer registry and fd table. js/boot/reset-realm.mjs
//     and main-thread-engine.mjs reach for the same module instance; a private
//     copy inside the bundle would give the reset barrel a registry nobody else
//     could see.
//   - `../cmachine.js`, `../yield-rt.js`, `../cjmp.js`, `../isaac64.js` — the
//     hand-written runtime, shared between both builds.
//   - `./nhconst.js`, `./nhmacro.js`, `./nhfield.js` — import-free leaves read
//     only as `NHC.x` / `NHM.x` / `FLD.x` namespaces. Leaving them as three
//     real modules preserves that idiom byte-for-byte and costs three requests.
//     Safe to hoist *ahead* of the bundle body because they import nothing and
//     touch no cptr: their evaluation is not observable in the registry.
//   - `__reset.js` — replaced by the bundle's own captureAll/resetAll, which
//     call the (renamed) per-module reset functions directly instead of through
//     176 namespace objects.
//   `./nhprop.js` and `./nhmacrofn.js` go INSIDE: they import decl.js, sys.js,
//   artifact.js and cmd.js and are part of the cycle.
//
// RENAMING, CHEAPEST FIRST. 46,415 top-level declarations land in one scope.
//   - 13,455 `$field` fold consts are `const $x = FLD.x`, character-identical in
//     every module that has them and never exported or imported. They collapse
//     to 2,718 shared consts at bundle scope, taking 1,719 duplicate names with
//     them. Verified rather than assumed: a declarator is only dropped when its
//     name is `$X` and its initialiser is exactly `FLD.X`, and a statement that
//     mixes anything else in is left alone and renamed normally.
//   - 24,129 `__slN` string-table consts restart their numbering in every file.
//     They rename mechanically, as do the 146 reset blocks resetify.mjs appends.
//   - **16** are real C symbols. §2.5's "247 collisions, 211 exported" counted
//     collisions with nhconst/nhmacro/nhfield, which stay outside as namespaces
//     and therefore collide with nothing.
// One rule covers all three: **earliest in evaluation order keeps the bare
// name**; every later claimant gets `name$<module>`. It is deterministic, it is
// auditable from `--stats`, and it is asserted.
//
// THE TRAP THAT IS NOT ABOUT DECLARATIONS. The tree calls its libc/tty shim
// through UNDECLARED GLOBALS — `getenv`, `open`, `fopen`, `raw_printf` and ~200
// others that js/boot/harness.mjs installs on globalThis. Across 167 module
// scopes that is unambiguous. In one scope it stops being so the moment a module
// declares a top-level binding of the same name, and six do (rnd.js has
// file-static getenv/fopen/fprintf/fputc; unixtty.js has `error`; pline.js has
// `raw_printf`). The first working build of this pass did exactly that and
// booted to "Unable to open SYSCF_FILE" with nothing thrown — no exception, no
// missing export, just a different game. So every identifier that is free in any
// module is collected and reserved BEFORE any bundle name is handed out: the
// module that declares the clashing name renames, and free references keep
// resolving to the global they always resolved to. See buildBundle().
//
// GRANULARITY: ONE CHUNK, and that is a measurement, not a default. The design
// asked for four to eight so fetches could overlap. Asked of the mirror
// (tools/judge-sim/wire-probe.mjs), transfer rate with the round trip removed is
// 3.92 MB/s on one stream and 2.7-2.9 on four, eight, sixteen and a hundred and
// eighty: a single stream already has the whole link, and every chunk past the
// first costs a request and a worse compression window for nothing.
// docs/NOTES-startup.md §8.3.
//
// WHY A LEXER AND NOT A PARSER. The same argument jslex.mjs makes: c2js output
// is regular by construction, and the three facts a scope hoist needs — where
// the top-level declarations are, which identifiers are references to them, and
// whether anything shadows them — are lexical. What is NOT assumed is the
// shadowing: every module's inner bindings (parameters, locals, catch and arrow
// parameters, labels) are collected, and a rename whose name is bound anywhere
// inside a function is refused outright rather than applied and hoped for.
//
// USAGE
//   node tools/c2js/bundle.mjs                        # -> js/generated-y/__bundle.js
//   node tools/c2js/bundle.mjs --dir js/generated
//   node tools/c2js/bundle.mjs --check                # exit 1 if it would change
//   node tools/c2js/bundle.mjs --stats
//   node tools/c2js/bundle.mjs --verify-order  # tree and bundle agree on every
//                                              # cptr pointer id (see below)
//
// Run from build.mjs after assertTreesHygienic(), gated on C2JS_BUNDLE, in the
// shape of maybeYield/maybeReset — so the four read-back-driven sidecar
// writers, assertNamespaceExports() and the hygiene assert all still scan the
// unbundled tree, and so yieldify's `rm -rf js/generated-y` cannot delete it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenize } from './jslex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(HERE, '..', '..');

/** Entry point of the transpiled program, as js/boot/harness.mjs imports it. */
const ENTRY = 'unixmain.js';

/** Generated modules that stay outside the bundle as namespace leaves. */
const NAMESPACE_LEAVES = new Set(['nhconst.js', 'nhmacro.js', 'nhfield.js']);

/** The reset barrel is superseded by the bundle's own; never an input. */
const BARREL = '__reset.js';

/** What the bundle re-exports, and where each name comes from. */
const BUNDLE_EXPORTS = [
    ['unixmain.js', 'main'],
    ['rnd.js', 'getRngLog'],
];

/** Delimiters, so the output is greppable and its sections are obvious. */
const MARK = (s) => `\n// ${'='.repeat(74)}\n// ${s}\n// ${'='.repeat(74)}\n`;

// ---------------------------------------------------------------------------
// evaluation order
// ---------------------------------------------------------------------------

/**
 * The modules a real `import('./unixmain.js')` evaluates, in the order it
 * evaluates them.
 *
 * Post-order depth-first over static imports taken in source order — which is
 * what the spec's InnerModuleEvaluation does — so the returned array is the
 * exact sequence of module bodies the browser runs today. Concatenating in this
 * order is what keeps every cptr pointer id where it is.
 *
 * Modules outside the bundle (the three namespace leaves) are not descended
 * into and not returned; they import nothing, so their own position cannot
 * matter.
 */
export function evaluationOrder(dirAbs, entry = ENTRY) {
    const state = new Map();  // file -> 'visiting' | 'done'
    const order = [];
    const importsOf = new Map();
    const visit = (f) => {
        if (state.has(f)) return;
        state.set(f, 'visiting');
        const deps = [];
        const src = fs.readFileSync(path.join(dirAbs, f), 'utf8');
        // Static imports only; the generated graph has no dynamic import.
        const seen = new Set();
        for (const m of src.matchAll(/^import[^'"]*['"]\.\/([A-Za-z0-9_.-]+\.js)['"]/gm)) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            deps.push(m[1]);
        }
        importsOf.set(f, deps);
        for (const d of deps) {
            if (NAMESPACE_LEAVES.has(d)) continue;
            if (!fs.existsSync(path.join(dirAbs, d))) continue;
            visit(d);
        }
        state.set(f, 'done');
        order.push(f);
    };
    visit(entry);
    return { order, importsOf };
}

// ---------------------------------------------------------------------------
// lexical analysis of one module
// ---------------------------------------------------------------------------

const KW = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch', 'this',
    'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'of', 'as', 'from',
    'true', 'false', 'null', 'undefined', 'await', 'async', 'static', 'get', 'set']);

/**
 * Everything the hoist needs to know about one module, from its token stream.
 *
 * `topDecls`   name -> {kind, tok}  every module-scope binding, in source order
 * `imports`    the statements to delete, already split into what they bind
 * `innerBound` every name bound anywhere below module scope, plus every label
 * `fieldConsts` the `const $x = FLD.x` statements, if the whole statement is
 *               nothing but such declarators
 * `edits`      char ranges to delete outright (imports, `export ` keywords)
 */
function scanModule(src, file) {
    const { tokens, oddities } = tokenize(src);
    if (oddities.length) {
        throw new Error(`${file}: lexer reported ${oddities.length} oddity(ies), first: `
            + JSON.stringify(oddities[0]));
    }
    const topDecls = [];
    const imports = [];
    const innerBound = new Set();
    const fieldConsts = [];
    const deletes = [];

    // Brace classification, so an object literal's keys can be told from a
    // block's labels. A `{` opens an object literal when it appears where an
    // expression may start; the preceding significant token decides.
    // `{` opens an OBJECT LITERAL only where an expression may start. The set
    // is deliberately tight: `else {`, `do {`, `) {` and `=> {` open blocks,
    // and admitting them would make a block's first statement look like a
    // property list. Getting this wrong in the other direction is caught by
    // the shorthand refusal below and, in the end, by the corpus.
    const EXPR_BEFORE = new Set(['(', ',', '=', '[', '?', '!', '+', '-', '*', '/', '%',
        '&&', '||', '??', '===', '!==', '==', '!=', '<', '>', '<=', '>=',
        'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield']);
    const braceStack = [];    // true when the brace is an object literal
    const inObjectLiteral = () => braceStack.length > 0 && braceStack[braceStack.length - 1];

    let depth = 0;            // ( [ { nesting
    let fnDepth = 0;          // > 0 inside any function body
    let prev = null;

    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        const next = tokens[k + 1];

        if (t.t === 'punc') {
            if (t.v === '{') {
                const isObj = prev === null ? false
                    : (prev.t === 'punc' ? EXPR_BEFORE.has(prev.v)
                        : (prev.t === 'id' ? EXPR_BEFORE.has(prev.v) : false));
                braceStack.push(isObj);
                depth++;
            } else if (t.v === '}') {
                braceStack.pop();
                depth--;
            } else if (t.v === '(' || t.v === '[') depth++;
            else if (t.v === ')' || t.v === ']') depth--;
            prev = t;
            continue;
        }
        if (t.t !== 'id') { prev = t; continue; }

        // ---- import statements (module scope only) ----
        if (t.v === 'import' && depth === 0) {
            let p = k + 1;
            while (p < tokens.length && tokens[p].t !== 'str') p++;
            const specTok = tokens[p];
            const spec = specTok.v.slice(1, -1);
            // bound names: `* as NS`, `{ a, b as c }`, `d` (default — none here)
            const binds = [];
            let ns = null;
            for (let q = k + 1; q < p; q++) {
                const tok = tokens[q];
                if (tok.t === 'punc' && tok.v === '*') {
                    // * as NS
                    ns = tokens[q + 2]?.v ?? null;
                    q += 2;
                    continue;
                }
                if (tok.t !== 'id' || tok.v === 'from') continue;
                if (tokens[q + 1]?.v === 'as') {
                    binds.push({ imported: tok.v, local: tokens[q + 2].v });
                    q += 2;
                } else if (tokens[q - 1]?.v !== 'as') {
                    binds.push({ imported: tok.v, local: tok.v });
                }
            }
            let end = specTok.j;
            if (tokens[p + 1]?.v === ';') end = tokens[p + 1].j;
            imports.push({ spec, ns, binds, from: t.i, to: end });
            deletes.push([t.i, end]);
            k = p + (tokens[p + 1]?.v === ';' ? 1 : 0);
            prev = tokens[k];
            continue;
        }

        // ---- `export` keyword at module scope: delete the word, keep the decl ----
        if (t.v === 'export' && depth === 0 && next) {
            deletes.push([t.i, next.i]);
            prev = t;
            continue;
        }

        // ---- function / generator declarations ----
        if (t.v === 'function') {
            let m = k + 1;
            if (tokens[m]?.v === '*') m++;
            const nameTok = tokens[m];
            if (nameTok && nameTok.t === 'id') {
                if (depth === 0) topDecls.push({ name: nameTok.v, kind: 'function', tok: nameTok });
                else innerBound.add(nameTok.v);
            }
            // parameters are inner bindings whatever the depth
            let p = m + (nameTok && nameTok.t === 'id' ? 1 : 0);
            if (tokens[p]?.v === '(') {
                let d = 0;
                for (let q = p; q < tokens.length; q++) {
                    const tok = tokens[q];
                    if (tok.t === 'punc') {
                        if (tok.v === '(') d++;
                        else if (tok.v === ')') { d--; if (d === 0) break; }
                    } else if (tok.t === 'id' && !KW.has(tok.v)) innerBound.add(tok.v);
                }
            }
            prev = t;
            continue;
        }

        // ---- let / const / var ----
        if (t.v === 'let' || t.v === 'const' || t.v === 'var') {
            const declKw = t.v;
            const exported = tokens[k - 1]?.v === 'export';
            const startTok = exported ? tokens[k - 1] : t;
            const declarators = [];
            let m = k + 1;
            let semi = null;
            for (;;) {
                const nameTok = tokens[m];
                if (!nameTok || nameTok.t !== 'id') break;
                let d = 0, p = m + 1;
                let initStart = null, initEnd = null;
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
                    while (p < tokens.length
                        && !(tokens[p].t === 'punc' && (tokens[p].v === ',' || tokens[p].v === ';'))) p++;
                }
                declarators.push({
                    nameTok,
                    init: initStart === null ? null
                        : tokens.slice(initStart, initEnd).map((x) => x.v).join(''),
                });
                if (tokens[p]?.v === ',') { m = p + 1; continue; }
                semi = tokens[p] || null;
                break;
            }
            // A statement made of nothing but `$X = FLD.X` declarators is a
            // fold block: deduplicable at bundle scope, and dropped from here.
            // Every module that has one has the *same* one for a given name, so
            // the bundle declares each `$X` once and every module's references
            // resolve to it unrenamed.
            const isFold = depth === 0 && !exported && declarators.length > 0
                && declarators.every((d) => d.nameTok.v[0] === '$'
                    && d.init === 'FLD.' + d.nameTok.v.slice(1));
            for (const d of declarators) {
                if (depth !== 0) innerBound.add(d.nameTok.v);
                else if (!isFold) topDecls.push({ name: d.nameTok.v, kind: declKw, tok: d.nameTok });
            }
            if (isFold) {
                fieldConsts.push(...declarators.map((d) => d.nameTok.v));
                const end = semi ? semi.j : declarators[declarators.length - 1].nameTok.j;
                deletes.push([startTok.i, end]);
            }
            k = m;
            prev = tokens[k];
            continue;
        }

        // ---- catch (e) ----
        if (t.v === 'catch' && next?.v === '(' && tokens[k + 2]?.t === 'id') {
            innerBound.add(tokens[k + 2].v);
        }

        // ---- labels: `name:` at statement position, and `break`/`continue name` ----
        if (next?.t === 'punc' && next.v === ':' && !inObjectLiteral()
            && (prev === null || prev.v === ';' || prev.v === '{' || prev.v === '}')
            && !KW.has(t.v)) {
            innerBound.add(t.v);
        }
        if ((t.v === 'break' || t.v === 'continue') && next?.t === 'id') innerBound.add(next.v);

        // ---- arrow parameters ----
        if (next?.t === 'punc' && next.v === '=>' && !KW.has(t.v)) innerBound.add(t.v);

        prev = t;
    }

    // Every identifier in a REFERENCE position — not a member name, not an
    // object key, not inside an import statement. The free ones (this minus the
    // module's own bindings) are what resolve to globals, and the bundle has to
    // know them: see FREE IDENTIFIERS in buildBundle().
    const refIds = new Set();
    {
        // Import statements are all at the head of a generated module, so one
        // bound is enough to skip them without a per-token span search.
        const importEnd = imports.reduce((a, i) => Math.max(a, i.to), 0);
        const importSpans = imports.map((i) => [i.from, i.to]);
        const inImport = (i) => i < importEnd && importSpans.some(([a, b]) => i >= a && i < b);
        const bs = [];
        let pv = null;
        for (let k = 0; k < tokens.length; k++) {
            const t = tokens[k];
            if (t.t === 'punc') {
                if (t.v === '{') {
                    bs.push(pv !== null && (pv.t === 'punc' || pv.t === 'id') && EXPR_BEFORE.has(pv.v));
                } else if (t.v === '}') bs.pop();
                pv = t;
                continue;
            }
            if (t.t !== 'id') { pv = t; continue; }
            if (KW.has(t.v)) { pv = t; continue; }
            if (pv && pv.t === 'punc' && (pv.v === '.' || pv.v === '?.')) { pv = t; continue; }
            if (bs.length && bs[bs.length - 1] && pv && pv.t === 'punc' && (pv.v === '{' || pv.v === ',')
                && tokens[k + 1]?.v === ':') { pv = t; continue; }
            if (!inImport(t.i)) refIds.add(t.v);
            pv = t;
        }
    }

    // A second sweep for parenthesised arrow parameter lists — `(a, b) => …`.
    // Cheap and conservative: everything inside the parentheses that closes
    // immediately before a `=>` is treated as bound. Over-inclusion only ever
    // makes the shadow assertion stricter.
    for (let k = 0; k < tokens.length; k++) {
        if (!(tokens[k].t === 'punc' && tokens[k].v === '=>')) continue;
        if (!(tokens[k - 1]?.t === 'punc' && tokens[k - 1].v === ')')) continue;
        let d = 0;
        for (let q = k - 1; q >= 0; q--) {
            const tok = tokens[q];
            if (tok.t === 'punc') {
                if (tok.v === ')') d++;
                else if (tok.v === '(') { d--; if (d === 0) break; }
            } else if (tok.t === 'id' && !KW.has(tok.v)) innerBound.add(tok.v);
        }
    }

    return { tokens, topDecls, imports, innerBound, fieldConsts, deletes, refIds };
}

// ---------------------------------------------------------------------------
// rewriting one module's body
// ---------------------------------------------------------------------------

/**
 * Apply the rename map and the deletions to one module's source.
 *
 * An identifier token is a *reference* unless it is a member name (`a.b`,
 * `a?.b`) or an object-literal key (`{ b: 1 }`). Shorthand properties
 * (`{ b }`) would need expanding rather than replacing, so they are refused
 * loudly instead — the corpus has none, and a silent wrong answer here is a
 * game that plays differently.
 */
function rewriteModule(src, scan, rename, file) {
    const { tokens, deletes } = scan;
    const edits = deletes.map(([from, to]) => ({ from, to, text: '' }));

    // `{` opens an OBJECT LITERAL only where an expression may start. The set
    // is deliberately tight: `else {`, `do {`, `) {` and `=> {` open blocks,
    // and admitting them would make a block's first statement look like a
    // property list. Getting this wrong in the other direction is caught by
    // the shorthand refusal below and, in the end, by the corpus.
    const EXPR_BEFORE = new Set(['(', ',', '=', '[', '?', '!', '+', '-', '*', '/', '%',
        '&&', '||', '??', '===', '!==', '==', '!=', '<', '>', '<=', '>=',
        'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield']);
    const braceStack = [];
    let prev = null;

    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.t === 'punc') {
            if (t.v === '{') {
                const isObj = prev === null ? false
                    : ((prev.t === 'punc' || prev.t === 'id') ? EXPR_BEFORE.has(prev.v) : false);
                braceStack.push(isObj);
            } else if (t.v === '}') braceStack.pop();
            prev = t;
            continue;
        }
        if (t.t !== 'id') { prev = t; continue; }
        const to = rename.get(t.v);
        if (to === undefined || to === t.v) { prev = t; continue; }
        // member name
        if (prev && prev.t === 'punc' && (prev.v === '.' || prev.v === '?.')) { prev = t; continue; }
        const inObj = braceStack.length > 0 && braceStack[braceStack.length - 1];
        if (inObj && prev && prev.t === 'punc' && (prev.v === '{' || prev.v === ',')) {
            const nx = tokens[k + 1];
            if (nx && nx.t === 'punc' && nx.v === ':') { prev = t; continue; }  // key
            if (nx && nx.t === 'punc' && (nx.v === ',' || nx.v === '}')) {
                throw new Error(`${file}: shorthand object property \`${t.v}\` needs renaming to `
                    + `\`${to}\`; expand it in the emitter before bundling`);
            }
        }
        edits.push({ from: t.i, to: t.j, text: to });
        prev = t;
    }

    edits.sort((a, b) => a.from - b.from || a.to - b.to);
    let out = '';
    let pos = 0;
    for (const e of edits) {
        if (e.from < pos) continue;   // inside a deleted range (an import's names)
        out += src.slice(pos, e.from) + e.text;
        pos = e.to;
    }
    out += src.slice(pos);
    return out;
}

// ---------------------------------------------------------------------------
// the reset barrel, minus its per-module indirection
// ---------------------------------------------------------------------------

/**
 * The snapshot/restore half of `__reset.js`, and every name it binds.
 *
 * The barrel's top half is 176 namespace imports and a table of them; in one
 * scope those are 176 renamed function declarations and the table can name them
 * directly. Its bottom half — the S/P snapshot helpers, the type tags, tag() —
 * is transplanted VERBATIM rather than reimplemented, so the bundle's reset and
 * the tree's reset cannot drift: there is one copy of that code and it is the
 * one tools/c2js/resetify.mjs writes.
 *
 * Returns `{helpers, names}`; `helpers` is null when the tree was built without
 * C2JS_RESET=1, which is a supported (if degraded) configuration.
 */
function readBarrel(dirAbs) {
    const barrelPath = path.join(dirAbs, BARREL);
    if (!fs.existsSync(barrelPath)) return { helpers: null, names: [] };
    const src = fs.readFileSync(barrelPath, 'utf8');
    const CUT = '// ---------------------------------------------------------------- snapshot --';
    const cut = src.indexOf(CUT);
    if (cut < 0) throw new Error('bundle: cannot find the snapshot section of ' + BARREL);
    const helpers = src.slice(cut)
        .replace(/^export function (S|P)\(/gm, 'function $1(')
        .replace(/^\/\*\*[^*]*\*\/\n(?=export function captureAll)/m, '')
        .replace(/^export function (captureAll|resetAll|statefulModules)\b[\s\S]*$/m, '');
    const names = scanModule(helpers, BARREL).topDecls.map((d) => d.name);
    // The four the bundle declares itself, in place of the barrel's.
    names.push('MODULES', 'captureAll', 'resetAll', 'statefulModules');
    return { helpers, names };
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

/** `apply.js` -> `apply`, `do_name.js` -> `do_name`; the rename suffix. */
const slugOf = (file) => file.replace(/\.js$/, '').replace(/[^A-Za-z0-9_$]/g, '_');

/**
 * Build the bundle for one directory.
 *
 * @returns {{text: string, stats: object}}
 */
export function buildBundle(dirRel) {
    const dirAbs = path.join(repoRoot, dirRel);
    const { order } = evaluationOrder(dirAbs);
    const modules = order.filter((f) => f !== BARREL && !NAMESPACE_LEAVES.has(f));

    // ---- pass 1: scan every module ----
    const scans = new Map();
    for (const f of modules) {
        const src = fs.readFileSync(path.join(dirAbs, f), 'utf8');
        scans.set(f, { src, ...scanModule(src, f) });
    }

    // ---- pass 2: collect the external imports, hoisted verbatim ----
    //
    // Every specifier that is not a bundled module. Their local names are
    // claimed in the global pool FIRST, so a generated module that happens to
    // declare `i16` is the one that gets renamed, not the runtime.
    const externalNames = new Map();   // spec -> { ns: Set, named: Map(local -> imported) }
    const inBundle = new Set(modules);
    for (const f of modules) {
        for (const imp of scans.get(f).imports) {
            const rel = imp.spec.startsWith('./') ? imp.spec.slice(2) : null;
            if (rel && inBundle.has(rel)) continue;      // internal: dissolved
            if (!externalNames.has(imp.spec)) externalNames.set(imp.spec, { ns: new Set(), named: new Map() });
            const e = externalNames.get(imp.spec);
            if (imp.ns) e.ns.add(imp.ns);
            for (const b of imp.binds) {
                const was = e.named.get(b.local);
                if (was !== undefined && was !== b.imported) {
                    throw new Error(`${f}: external name \`${b.local}\` means \`${was}\` in one module `
                        + `and \`${b.imported}\` in another; the hoist cannot merge them`);
                }
                e.named.set(b.local, b.imported);
            }
        }
    }
    const taken = new Set();
    for (const [, e] of externalNames) {
        for (const n of e.ns) taken.add(n);
        for (const [local] of e.named) taken.add(local);
    }
    const externalReserved = new Set(taken);

    // The inlined reset barrel brings its own module-scope names — the snapshot
    // tags, S/P, tag(), MODULES, captured — into the same scope. Reserve them
    // here rather than after the fact: a generated module that declares `S` or
    // `MODULES` must be the thing that renames, and finding that out from a
    // duplicate-declaration SyntaxError 293,000 lines in is not a plan.
    const barrel = readBarrel(dirAbs);
    for (const n of barrel.names) taken.add(n);

    // FREE IDENTIFIERS — the trap this pass exists to not fall into.
    //
    // The generated tree calls the libc/tty shim through *undeclared globals*:
    // `getenv`, `open`, `error`, `strcmp` and ~200 others are neither declared
    // nor imported anywhere, and js/boot/harness.mjs installs them on
    // globalThis before the graph evaluates. In 167 separate module scopes that
    // is unambiguous. In ONE scope it stops being so the moment some module
    // declares a top-level binding with the same name — and one does:
    // unixtty.js has a file-static `error`, so a naive hoist would silently
    // redirect every other module's calls to the harness's `error()` into it.
    // Nothing would throw; the game would just behave differently, which is the
    // worst possible failure mode for a parity port.
    //
    // The fix is the cheap direction: collect every identifier that is free in
    // any module — referenced, but not declared there, not imported there and
    // not bound inside a function there — and reserve all of them. The module
    // that declares the clashing name is then the thing that renames, and every
    // free reference keeps resolving to the global it always resolved to.
    const freeIds = new Set();
    for (const f of modules) {
        const scan = scans.get(f);
        const own = new Set(scan.topDecls.map((d) => d.name));
        for (const imp of scan.imports) {
            if (imp.ns) own.add(imp.ns);
            for (const b of imp.binds) own.add(b.local);
        }
        for (const id of scan.refIds) {
            if (own.has(id) || scan.innerBound.has(id) || id[0] === '$') continue;
            freeIds.add(id);
        }
    }
    for (const n of freeIds) taken.add(n);

    // The deduplicated struct-offset folds are declared once at bundle scope, so
    // their names are claimed before any module's — a module that declares `$X`
    // in a statement the fold rule did NOT match then renames around it rather
    // than silently redeclaring the shared one.
    const fieldAll = new Set();
    for (const f of modules) for (const n of scans.get(f).fieldConsts) fieldAll.add(n);
    for (const n of fieldAll) taken.add(n);

    // ---- pass 3: assign a bundle name to every top-level declaration ----
    //
    // Earliest in evaluation order keeps the bare name. Later claimants get
    // `name$<module>`; the suffix is the module the declaration came from, so
    // the output reads like the tree it was made from.
    const bundleName = new Map();      // `${file}\0${local}` -> bundle name
    const owner = new Map();           // bundle name -> file (for the census)
    const collisions = [];
    for (const f of modules) {
        const slug = slugOf(f);
        for (const d of scans.get(f).topDecls) {
            const key = f + '\0' + d.name;
            if (bundleName.has(key)) continue;   // `let x; … x = 1` re-listed
            let name = d.name;
            if (taken.has(name)) {
                name = `${d.name}$${slug}`;
                if (taken.has(name)) {
                    let n = 2;
                    while (taken.has(`${name}_${n}`)) n++;
                    name = `${name}_${n}`;
                }
                collisions.push({ file: f, from: d.name, to: name, kind: d.kind,
                    was: externalReserved.has(d.name) ? '<runtime import>'
                        : freeIds.has(d.name) ? '<a global the tree calls>'
                            : owner.get(d.name) });
            }
            taken.add(name);
            owner.set(name, f);
            bundleName.set(key, name);
        }
    }

    // ---- pass 4: the per-module rename maps, and the shadow assertion ----
    const renames = new Map();
    const shadowed = [];
    for (const f of modules) {
        const scan = scans.get(f);
        const map = new Map();
        for (const d of scan.topDecls) {
            const to = bundleName.get(f + '\0' + d.name);
            if (to !== d.name) map.set(d.name, to);
        }
        for (const imp of scan.imports) {
            const rel = imp.spec.startsWith('./') ? imp.spec.slice(2) : null;
            if (!rel || !inBundle.has(rel)) continue;    // external: name unchanged
            if (imp.ns) {
                throw new Error(`${f}: namespace import of bundled module ${rel}; `
                    + 'the hoist has no namespace object to give it');
            }
            for (const b of imp.binds) {
                const to = bundleName.get(rel + '\0' + b.imported);
                if (to === undefined) {
                    throw new Error(`${f}: imports \`${b.imported}\` from ${rel}, which does not declare it`);
                }
                if (to !== b.local) map.set(b.local, to);
            }
        }
        for (const name of map.keys()) {
            if (scan.innerBound.has(name)) shadowed.push(`${f}: ${name}`);
        }
        renames.set(f, map);
    }
    if (shadowed.length) {
        throw new Error(`bundle: ${shadowed.length} rename target(s) are also bound inside a `
            + `function, where a token-level rename would be wrong: ${shadowed.slice(0, 8).join(', ')}`
            + (shadowed.length > 8 ? ' …' : ''));
    }

    // ---- pass 5: emit ----
    const L = [];
    L.push('// Generated by tools/c2js/bundle.mjs — do not edit by hand.');
    L.push('//');
    L.push(`// ${modules.length} modules of ${dirRel} scope-hoisted into one, in ESM evaluation`);
    L.push('// order (depth-first post-order from ' + ENTRY + '), so every cptr pointer id lands');
    L.push('// exactly where the per-module tree puts it. The tree itself is unchanged and is');
    L.push('// still what every build tool reads; this is a deployment artifact, and it exists');
    L.push("// because the mirror's edge charges 12-16 ms per request whatever the request is.");
    L.push('//');
    L.push('// See docs/NOTES-startup.md §8.');
    L.push('');

    for (const [spec, e] of [...externalNames].sort((a, b) => a[0].localeCompare(b[0]))) {
        for (const ns of [...e.ns].sort()) L.push(`import * as ${ns} from '${spec}';`);
        const named = [...e.named].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`));
        if (named.length) L.push(`import { ${named.join(', ')} } from '${spec}';`);
    }

    if (fieldAll.size) {
        L.push(MARK(`${fieldAll.size} struct-offset folds, deduplicated`
            + ' — `const $x = FLD.x`, identical in every module that had one'));
        const names = [...fieldAll].sort();
        for (let i = 0; i < names.length; i += 6) {
            L.push('const ' + names.slice(i, i + 6).map((n) => `${n} = FLD.${n.slice(1)}`).join(', ') + ';');
        }
    }

    for (const f of modules) {
        L.push(MARK(`${dirRel}/${f}`));
        L.push(rewriteModule(scans.get(f).src, scans.get(f), renames.get(f), f).trim());
    }

    // ---- pass 6: the reset barrel, inlined ----
    //
    // __reset.js drives 176 namespace objects' __captureState/__resetState. In
    // one scope those are 176 renamed function declarations, so the barrel
    // becomes a direct call list — and the S/P snapshot helpers come straight
    // out of the file it replaces, so the two can never drift.
    let statefulCount = 0;
    if (barrel.helpers !== null) {
        // Which modules actually carry state: the ones whose __captureState survived.
        const stateful = modules.filter((f) => bundleName.has(f + '\0__captureState'));
        statefulCount = stateful.length;
        L.push(MARK('the reset barrel, inlined — was ' + dirRel + '/' + BARREL));
        L.push(barrel.helpers.trimEnd());
        L.push('');
        L.push('const MODULES = [');
        for (const f of stateful) {
            L.push(`    ['${f}', ${bundleName.get(f + '\0__captureState')}, ${bundleName.get(f + '\0__resetState')}],`);
        }
        L.push('];');
        L.push('');
        L.push('/** Record the pristine state of the whole graph. See ' + dirRel + '/' + BARREL + '. */');
        L.push('export function captureAll() {');
        L.push('    if (captured) return false;');
        L.push('    for (const [name, cap] of MODULES) {');
        L.push("        try { cap(S); } catch (e) { throw tag(e, 'capture', name); }");
        L.push('    }');
        L.push('    cptr.__captureState();');
        L.push('    captured = true;');
        L.push('    return true;');
        L.push('}');
        L.push('');
        L.push('/** Put the whole graph back to what captureAll() recorded. */');
        L.push('export function resetAll() {');
        L.push("    if (!captured) throw new Error('c2js reset: resetAll() before captureAll()');");
        L.push('    for (const [name, , put] of MODULES) {');
        L.push("        try { put(P); } catch (e) { throw tag(e, 'reset', name); }");
        L.push('    }');
        L.push('    // cptr last: the pointer registry\'s captured length is only meaningful');
        L.push('    // once the buffers whose bytes hold those ids are back to pristine.');
        L.push('    cptr.__resetState();');
        L.push('}');
        L.push('');
        L.push('/** Which modules carry state, for tools/c2js/reset-census.mjs and the notes. */');
        L.push('export function statefulModules() { return MODULES.map(([n]) => n); }');
    }

    // ---- pass 7: what the four call sites in js/boot/ import ----
    L.push(MARK('what js/boot/ imports — one specifier for what were three'));
    const reexports = [];
    for (const [file, name] of BUNDLE_EXPORTS) {
        const to = bundleName.get(file + '\0' + name);
        if (to === undefined) throw new Error(`bundle: ${file} does not export \`${name}\``);
        reexports.push(to === name ? name : `${to} as ${name}`);
    }
    L.push(`export { ${reexports.join(', ')} };`);
    L.push('');

    const text = L.join('\n');
    const declCount = modules.reduce((a, f) => a + scans.get(f).topDecls.length, 0);
    const foldDecls = modules.reduce((a, f) => a + scans.get(f).fieldConsts.length, 0);
    return {
        text,
        stats: {
            modules: modules.length,
            declarations: declCount + foldDecls,
            fieldFolds: fieldAll.size,
            foldDecls,
            hoisted: declCount,
            renamed: collisions.length,
            realCollisions: collisions.filter((c) => !/^__sl\d+$/.test(c.from)
                && !/^__(c2js_rs|captureState|resetState)$/.test(c.from)).length,
            stateful: statefulCount,
            bytes: text.length,
            collisions,
        },
    };
}

// ---------------------------------------------------------------------------
// --verify-order: the proof, not the argument
// ---------------------------------------------------------------------------
//
// Everything in this file rests on one claim: the bundle's module bodies run in
// the same order the per-module tree's do. The argument is that a post-order
// depth-first walk over static imports IS what the spec's InnerModuleEvaluation
// performs. The proof is that the two orders produce the same pointer ids.
//
// js/cptr.js's registry is append-only and an id is its index, so the id handed
// out by the FIRST store after the graph has finished evaluating counts every
// `cptr.lit`/`cptr.alloc` the graph performed, in order. `__nextBufId` is the
// second such counter. Evaluate the tree in one process and the bundle in
// another, ask both, and compare: if a single top-level initialiser had moved,
// the counts would differ — and if none did, they cannot.
//
// Why it matters more than it sounds: the Lua VM seeds its string hashes from
// pointer ids, so a shifted registry is a different hash table, a different
// iteration order, and a different game. It would not throw. It would just
// stop matching the recording somewhere in the middle of a level.
async function verifyOrder(dirRel) {
    const { execFileSync } = await import('node:child_process');
    const url = (rel) => pathToFileURL(path.join(repoRoot, rel)).href;
    const probe = (spec) => `
        const t0 = Date.now();
        await import(${JSON.stringify(spec)});
        const cptr = await import(${JSON.stringify(url('js/cptr.js'))});
        // One store into a scratch cell: the id it is given is BASE + the
        // registry's length, i.e. exactly how many pointers the graph stored.
        const cell = cptr.alloc(8);
        cptr.stPtr(cell, cell);
        console.log(JSON.stringify({
            ptrId: String(cptr.ldU64(cell)),
            bufId: String(cptr.addr(cptr.alloc(1))),
            ms: Date.now() - t0,
        }));`;
    const run = (rel) => JSON.parse(execFileSync(process.execPath,
        ['--input-type=module', '-e', probe(url(rel))],
        { cwd: repoRoot, encoding: 'utf8' }).trim());
    const tree = run(`${dirRel}/${BARREL}`);
    const bundle = run(`${dirRel}/__bundle.js`);
    const same = tree.ptrId === bundle.ptrId && tree.bufId === bundle.bufId;
    console.log(`evaluation order, ${dirRel}:`);
    console.log(`  per-module tree (${BARREL})  pointer registry -> ${tree.ptrId}, `
        + `next buffer id ${tree.bufId}   (${tree.ms} ms to evaluate)`);
    console.log(`  scope-hoisted bundle        pointer registry -> ${bundle.ptrId}, `
        + `next buffer id ${bundle.bufId}   (${bundle.ms} ms to evaluate)`);
    console.log(same
        ? '  IDENTICAL — every top-level initialiser ran in the same place.'
        : '  DIFFERENT — a top-level initialiser moved; the bundle is not parity-safe.');
    return same;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const argVal = (f) => {
    const i = args.findIndex((a) => a === f || a.startsWith(f + '='));
    if (i < 0) return null;
    return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : (args[i + 1] ?? null);
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const dirs = argVal('--dir') ? [argVal('--dir')] : ['js/generated-y'];
    if (args.includes('--verify-order')) {
        let ok = true;
        for (const dir of dirs) ok = (await verifyOrder(dir)) && ok;
        process.exit(ok ? 0 : 1);
    }
    const check = args.includes('--check');
    const stats = args.includes('--stats');
    let changed = 0;
    for (const dir of dirs) {
        const out = path.join(repoRoot, dir, '__bundle.js');
        const { text, stats: s } = buildBundle(dir);
        const was = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
        if (check) {
            if (was !== text) { changed++; console.error(`bundle: ${dir}/__bundle.js would change`); }
        } else if (was !== text) {
            fs.writeFileSync(out, text);
        }
        console.log(`bundle ${dir}: ${s.modules} modules -> 1 file, `
            + `${(s.bytes / 1024 / 1024).toFixed(2)} MB; ${s.declarations} top-level declarations `
            + `-> ${s.hoisted} hoisted + ${s.foldDecls} struct-offset folds deduplicated to ${s.fieldFolds}; `
            + `${s.renamed} renamed (${s.realCollisions} of them real C symbols); `
            + `${s.stateful} stateful modules in the barrel`);
        if (stats) {
            for (const c of s.collisions.filter((x) => !/^__sl\d+$/.test(x.from)
                && !/^__(c2js_rs|captureState|resetState)$/.test(x.from))) {
                console.log(`    ${c.from} -> ${c.to}   (${c.kind}, ${c.file}; bare name held by ${c.was})`);
            }
        }
    }
    if (check && changed) process.exit(1);
}
