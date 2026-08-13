#!/usr/bin/env node
// resetify.mjs — give every generated module a way to be put back.
//
// Appends to each js/generated/*.js that owns state:
//
//     export function __captureState(S) { __c2js_rs = [S(a), S(b), ...]; }
//     export function __resetState(P)   { a = P(r[0]); P(r[1]); ... }
//
// and writes js/generated/__reset.js, the barrel that imports all of them,
// supplies the snapshot/restore helpers, and drives js/cptr.js's own reset.
//
// WHY A POST-PASS AND NOT AN emit.mjs MODE — the same three reasons
// tools/c2js/yieldify.mjs gives, and one more that is specific to this pass:
//   1. The sync build in js/generated/ is the scored build. A post-pass cannot
//      alter it with the flag off, because with the flag off the pass does not
//      run — "byte-identical output" is a fact of the file layout, not a
//      property to be tested.
//   2. build.mjs inlines the hand-written runtime preludes
//      (tools/c2js/runtime/*-prelude.js) into the generated modules verbatim;
//      emit.mjs never sees them. rnd.js's `__rngLog` — the scored RNG log, and
//      as load-bearing a piece of per-game state as exists — lives in a
//      prelude. An emit.mjs-side pass would miss it. This pass reads the
//      emitted module, where the prelude has already been inlined, and picks
//      it up with everything else.
//   3. emit.mjs sees one translation unit at a time and has no place to put a
//      barrel over all 176.
//   4. (new) The analysis is over the *emitted* declarations, which is exactly
//      the set that has to be reset. Deriving it from the IR would mean
//      maintaining a second model of what emit.mjs decided to emit, and the
//      two would drift.
//
// WHAT IS NOT RESET, AND WHY
//   - `const` bound to a number (4,160 of them). A const scalar cannot change.
//   - `cptr.lit("...")` (24,163 of them). These are C *string literals*;
//     writing through one is undefined behaviour in C and NetHack does not do
//     it. Checked rather than assumed — `reset-census.mjs --verify-lits` plays
//     a session with every lit buffer watched and reports any that moved.
//   - Function declarations, imports, and the module's own reset block.
//
// THE SNAPSHOT IS BY VALUE, WHICH BUYS ORDER-INDEPENDENCE. Every restorable
// binding is captured as (original object, copy of its contents). Restoring
// writes the copy back into the *original* object and rebinds the variable to
// it. Nothing in a reset reads another module's live state, so the order in
// which modules are reset cannot matter — which is worth more than the few
// bytes a smarter scheme would save, given the graph is cyclic and has no
// natural order to appeal to.
//
// USAGE
//   node tools/c2js/resetify.mjs                  # -> js/generated/**
//   node tools/c2js/resetify.mjs --dir js/generated-y   # the yieldable build
//   node tools/c2js/resetify.mjs --check          # exit 1 if it would change
//   node tools/c2js/resetify.mjs --strip          # remove every reset block
//   node tools/c2js/resetify.mjs --stats
//
// `--dir` is why this pass is a post-pass twice over. js/generated-y/ is
// tools/c2js/yieldify.mjs's whole-program rewrite of js/generated/, and the
// interactive Node rung (js/boot/main-thread-engine.mjs) needs the same
// one-graph-many-games property the scored path gets. It cannot inherit the
// blocks through yieldify: the rewrite would colour `__captureState`'s calls to
// its `S` parameter as indirect calls and emit `(yield* Y.icall(S(x)))`, making
// the reset functions generators that the barrel cannot call. So yieldify
// strips the block on the way through (tools/c2js/callgraph.mjs) and this pass
// runs over the yieldable directory in its own right, where the top-level
// declarations it analyses are — by construction, since yieldify emits no
// top-level coloured call — the same 1,395 bindings as the sync build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    analyzeModule, KIND, STRATEGY, repoRoot,
    RESET_BARREL as BARREL, RESET_BEGIN as BEGIN, RESET_END as END, stripResetBlock,
} from './reset-census.mjs';
import { fillItems, FMT_ON, FMT_COLS } from './jsfmt.mjs';

/**
 * Does this declaration need anything doing to it, and what?
 *
 * `rebind`  the variable may be reassigned by game code, so put the binding
 *           back (only possible for let/var — a const binding cannot move).
 * `restore` the *contents* of what it is bound to may be written, so put the
 *           bytes back.
 * A declaration can need both: `let zero_artiexist = cptr.alloc(36)` is a
 * pointer variable the game may repoint AND an arena the game writes into.
 */
export function planFor(d) {
    if (d.kind === KIND.LIT) return null;
    const mutableBinding = d.declKw !== 'const';
    const mutableContents = STRATEGY[d.kind] === 'snapshot';
    if (!mutableBinding && !mutableContents) return null; // const scalar
    return { rebind: mutableBinding, restore: mutableContents };
}

/** Strip a previously appended reset block (idempotence). See reset-census.mjs. */
export const stripBlock = stripResetBlock;

/**
 * The block to append for one module, or null when it owns no state.
 *
 * `genDirRel` only names the barrel in a comment, but it has to be right: the
 * two builds have two barrels, and a comment pointing at the other directory's
 * would be the sort of small lie that costs an hour later.
 */
export function blockFor(src, file, genDirRel = 'js/generated') {
    const { decls, warnings } = analyzeModule(src, { file });
    const bad = warnings.filter((w) => w.kind === 'unclassified');
    if (bad.length) {
        throw new Error(`${file}: ${bad.length} unclassified top-level declaration(s), `
            + `first: ${bad[0].detail}. Classify it in reset-census.mjs before emitting a `
            + 'reset that would silently skip it.');
    }
    const items = [];
    for (const d of decls) {
        const p = planFor(d);
        if (p) items.push({ name: d.name, ...p, kind: d.kind, line: d.line });
    }
    if (items.length === 0) return null;

    // filled to the column budget (tools/c2js/jsfmt.mjs) — decl.js's capture is
    // 150 bindings and was 2.5 KB on one line
    const capLines = fillItems(items.map((it) => `S(${it.name})`), 8);
    const put = items.map((it, i) => (it.rebind ? `${it.name} = P(r[${i}]);` : `P(r[${i}]);`));

    // Restores are one per line so a stack trace from a bad restore names the
    // binding; the capture is one expression because nothing can fail in it
    // that would not also fail in the restore.
    const lines = [
        '',
        BEGIN,
        '// ' + items.length + ' bindings: '
            + items.filter((i) => i.rebind && i.restore).length + ' rebound+refilled, '
            + items.filter((i) => i.rebind && !i.restore).length + ' rebound, '
            + items.filter((i) => !i.rebind && i.restore).length + ' refilled.',
        `// S/P are supplied by ${genDirRel}/__reset.js so this module needs no new import.`,
        'let __c2js_rs = null;',
        ...(!FMT_ON || (capLines.length === 1 && capLines[0].trim().length + 47 <= FMT_COLS)
            ? [`export function __captureState(S) { __c2js_rs = [${items.map((it) => `S(${it.name})`).join(', ')}]; }`]
            : ['export function __captureState(S) {', '    __c2js_rs = [', ...capLines, '    ];', '}']),
        'export function __resetState(P) {',
        '    const r = __c2js_rs;',
        '    if (r === null) throw new Error(' + JSON.stringify(file + ': __resetState before __captureState') + ');',
        ...put.map((s) => '    ' + s),
        '}',
        END,
        '',
    ];
    return { text: lines.join('\n'), items };
}

// ------------------------------------------------------------- the barrel ---

/** Entry point of the transpiled program, as js/boot/harness.mjs imports it. */
const ENTRY = 'unixmain.js';

/**
 * The modules a real boot actually evaluates, reachable from ENTRY.
 *
 * This is not tidiness, it is correctness, twice over:
 *
 *   - js/generated/isaac64.js is NOT in the graph (the transpiled rnd.js
 *     imports the hand-written js/isaac64.js instead), and it does not even
 *     compile: it imports `isaac64_init` and then declares it. Nothing has ever
 *     noticed because nothing has ever loaded it. A barrel over `readdir()`
 *     loads it and dies.
 *
 *   - a module the barrel pulls in that a boot would not is a module whose
 *     top-level initialisers run, pushing entries into cptr's pointer registry
 *     that a fresh realm would not have. Pointer ids are indices into that
 *     registry, so the reset realm's FIRST game would already be numbering
 *     pointers differently from the reference — a parity divergence introduced
 *     by the measuring apparatus itself.
 */
function reachableFrom(dir, entry) {
    const seen = new Set();
    const order = [];
    const stack = [entry];
    while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        const p = path.join(dir, f);
        if (!fs.existsSync(p)) continue;
        seen.add(f);
        order.push(f);
        const src = fs.readFileSync(p, 'utf8');
        // Static imports only; the generated graph has no dynamic import.
        for (const m of src.matchAll(/^import[^'"]*['"]\.\/([A-Za-z0-9_.-]+\.js)['"]/gm)) {
            stack.push(m[1]);
        }
    }
    return { seen, order };
}

function barrelSource(modules) {
    // ENTRY first, and alone on its line: ES modules evaluate dependencies in
    // the order their imports appear, so this import is what fixes the
    // evaluation order of the whole graph to the one a real boot produces.
    // Were the barrel to list the modules alphabetically instead, they would
    // evaluate alphabetically, their top-level initialisers would run in a
    // different order, and every pointer id in the registry would shift.
    const rest = modules.filter((m) => m !== ENTRY);
    const imports = [`import './${ENTRY}';`, ...rest.map((m, i) => `import * as M${i} from './${m}';`)];
    const withIdx = rest.map((m, i) => [m, `M${i}`]);
    // ENTRY itself still needs its reset driven; import it a second time under
    // a namespace, which is free (the module is already in the map).
    if (modules.includes(ENTRY)) {
        imports.push(`import * as MENTRY from './${ENTRY}';`);
        withIdx.unshift([ENTRY, 'MENTRY']);
    }
    const list = withIdx.map(([m, ns]) => `    ['${m}', ${ns}],`);
    return `// Generated by tools/c2js/resetify.mjs — do not edit by hand
//
// The barrel that makes one module graph serve unlimited games.
//
// captureAll() records the pristine state of all ${modules.length} stateful generated
// modules plus js/cptr.js. It MUST be called once, after the graph has finished
// evaluating and before any game runs — js/boot/reset-realm.mjs does that.
// resetAll() puts every one of them back.
//
// The snapshot/restore helpers live here rather than in each module so that
// resetify.mjs adds no import to any generated file: six of them (nhconst,
// nhmacro, dlb, lctype, lopcodes, unixres) do not import cptr at all, and a
// pass that had to add imports would be rewriting module headers instead of
// appending to module tails.

${imports.join('\n')}
import * as cptr from '../cptr.js';

const MODULES = [
${list.join('\n')}
];

// ---------------------------------------------------------------- snapshot --
//
// A snapshot is (the original object, a copy of its contents). Restoring
// writes the copy back into the ORIGINAL object and hands it back, so a
// variable the game repointed lands on the same object a fresh realm would
// have, with the same bytes in it.
//
// Tags, rather than re-sniffing the shape on the way back: the sniff happens
// once per binding per capture instead of once per binding per reset, and a
// value whose shape somehow changed during a game cannot send the restore down
// a different path than the capture took.

const T_VALUE = 0;   // number | bigint | string | boolean | null | undefined | function
const T_VIEW = 1;    // TypedArray
const T_PTR = 2;     // CPtr { buf: TypedArray, off }
const T_BOX = 3;     // { isBox: true, v }
const T_ARRAY = 4;   // Array, possibly carrying a .buf (the 2-D row-view idiom)
const T_PTRA = 5;    // CPtr whose buf is plain-Array storage (js/cptr.js supports
                     // both; the plain-Array form has no .set and no .subarray)

export function S(v) {
    if (v === null || v === undefined) return { t: T_VALUE, v };
    const ty = typeof v;
    if (ty !== 'object') return { t: T_VALUE, v };
    if (ArrayBuffer.isView(v)) return { t: T_VIEW, v, b: v.slice() };
    if (Array.isArray(v)) {
        const a = new Array(v.length);
        for (let i = 0; i < v.length; i++) a[i] = S(v[i]);
        // The row-view tables carry the flat backing store as \`.buf\`; every
        // row is a subarray of it, so restoring the rows already restores the
        // flat buffer. It is captured anyway, because the rows do not have to
        // cover it and a gap would otherwise keep the previous game's bytes.
        return { t: T_ARRAY, v, a, n: v.length, buf: v.buf === undefined ? null : S(v.buf) };
    }
    if (v.isBox === true) return { t: T_BOX, v, inner: S(v.v) };
    if (v.buf !== undefined) {
        const b = v.buf;
        if (ArrayBuffer.isView(b)) return { t: T_PTR, v, b: b.slice() };
        // Plain-Array storage: js/cptr.js supports a CPtr whose buf is an
        // ordinary Array (memcpy's slice path exists for exactly this), and
        // such a buffer may hold CPtrs rather than bytes — so its elements are
        // snapshotted rather than copied.
        if (Array.isArray(b)) {
            const a = new Array(b.length);
            for (let i = 0; i < b.length; i++) a[i] = S(b[i]);
            return { t: T_PTRA, v, a, n: b.length };
        }
    }
    // Deliberately loud. tools/c2js/reset-census.mjs classifies every top-level
    // declaration in js/generated/** and reports none of this shape; if one
    // appears, the reset must learn about it rather than silently leave the
    // previous game's object in place.
    throw new Error('c2js reset: cannot snapshot ' + Object.prototype.toString.call(v)
        + ' (keys: ' + Object.keys(v).slice(0, 8).join(',') + ')');
}

export function P(s) {
    switch (s.t) {
        case T_VALUE: return s.v;
        case T_VIEW: s.v.set(s.b); return s.v;
        case T_PTR: s.v.buf.set(s.b); return s.v;
        case T_PTRA: {
            const b = s.v.buf, a = s.a;
            if (b.length !== s.n) b.length = s.n;
            for (let i = 0; i < s.n; i++) b[i] = P(a[i]);
            return s.v;
        }
        case T_BOX: s.v.v = P(s.inner); return s.v;
        case T_ARRAY: {
            const v = s.v, a = s.a;
            if (v.length !== s.n) v.length = s.n;
            for (let i = 0; i < s.n; i++) v[i] = P(a[i]);
            if (s.buf !== null) P(s.buf);
            return v;
        }
        default: throw new Error('c2js reset: bad snapshot tag ' + s.t);
    }
}

// A failure in here is a failure inside one of 146 modules and 1,395 bindings,
// and the raw message ("s.v.buf.set is not a function") names none of them.
function tag(e, phase, name) {
    e.message = 'c2js ' + phase + ' failed in ' + name + ': ' + e.message;
    return e;
}

let captured = false;

/** Record the pristine state of the whole graph. Idempotent. */
export function captureAll() {
    if (captured) return false;
    for (const [name, m] of MODULES) {
        try { m.__captureState(S); } catch (e) { throw tag(e, 'capture', name); }
    }
    cptr.__captureState();
    captured = true;
    return true;
}

/** Put the whole graph back to what captureAll() recorded. */
export function resetAll() {
    if (!captured) throw new Error('c2js reset: resetAll() before captureAll()');
    for (const [name, m] of MODULES) {
        try { m.__resetState(P); } catch (e) { throw tag(e, 'reset', name); }
    }
    // cptr last: the pointer registry's captured length is only meaningful
    // once the buffers whose bytes hold those ids are back to pristine.
    cptr.__resetState();
}

/** Which modules carry state, for tools/c2js/reset-census.mjs and the notes. */
export function statefulModules() { return MODULES.map(([n]) => n); }
`;
}

// ------------------------------------------------------------------- main ---

function argVal(argv, flag) {
    const i = argv.findIndex((a) => a === flag || a.startsWith(flag + '='));
    if (i < 0) return null;
    return argv[i].includes('=') ? argv[i].slice(flag.length + 1) : (argv[i + 1] ?? null);
}

function main(argv) {
    const opts = { check: argv.includes('--check'), strip: argv.includes('--strip'), stats: argv.includes('--stats') };
    const genDirRel = (argVal(argv, '--dir') || 'js/generated').replace(/\/+$/, '');
    const GEN_DIR = path.join(repoRoot, genDirRel);
    if (!fs.existsSync(GEN_DIR)) {
        process.stdout.write(`resetify: ${genDirRel} does not exist — nothing to do\n`);
        return 0;
    }
    const files = fs.readdirSync(GEN_DIR).filter((f) => f.endsWith('.js') && f !== BARREL).sort();
    const { seen: live, order: evalOrder } = reachableFrom(GEN_DIR, ENTRY);
    const dead = files.filter((f) => !live.has(f));

    const stateful = [];
    const changes = [];
    let bindings = 0;
    // Walk in evaluation order so the barrel's MODULES list — and therefore the
    // order resets happen in — matches the order the graph was built in. The
    // snapshot is by value, so this cannot affect correctness; it makes a
    // failure easier to read, which can.
    for (const f of evalOrder.filter((f) => files.includes(f))) {
        const p = path.join(GEN_DIR, f);
        const orig = fs.readFileSync(p, 'utf8');
        const base = stripBlock(orig);
        let next = base;
        if (!opts.strip) {
            const b = blockFor(base, f, genDirRel);
            if (b) { next = base + b.text; stateful.push(f); bindings += b.items.length; }
        }
        if (next !== orig) changes.push({ file: f, path: p, text: next });
    }
    // A module outside the graph gets no block: it is not evaluated by a boot,
    // so it holds nothing a second game could see.
    for (const f of dead) {
        const p = path.join(GEN_DIR, f);
        const orig = fs.readFileSync(p, 'utf8');
        const base = stripBlock(orig);
        if (base !== orig) changes.push({ file: f, path: p, text: base });
    }

    const barrelPath = path.join(GEN_DIR, BARREL);
    const haveBarrel = fs.existsSync(barrelPath);
    if (opts.strip) {
        if (haveBarrel && !opts.check) fs.unlinkSync(barrelPath);
    } else {
        const want = barrelSource(stateful);
        if (!haveBarrel || fs.readFileSync(barrelPath, 'utf8') !== want) {
            changes.push({ file: BARREL, path: barrelPath, text: want });
        }
    }

    if (opts.check) {
        process.stdout.write(changes.length === 0
            ? 'resetify: up to date\n'
            : `resetify: ${changes.length} file(s) would change:\n  ${changes.map((c) => c.file).slice(0, 20).join('\n  ')}\n`);
        return changes.length === 0 ? 0 : 1;
    }

    for (const c of changes) fs.writeFileSync(c.path, c.text);
    process.stdout.write(opts.strip
        ? `resetify --strip ${genDirRel}: ${changes.length} file(s) reverted\n`
        : `resetify ${genDirRel}: ${stateful.length}/${live.size} live modules carry state, `
          + `${bindings} bindings, ${changes.length} file(s) written`
          + (dead.length ? ` (${dead.length} module(s) outside the graph skipped: ${dead.join(', ')})\n` : '\n'));
    if (opts.stats) {
        for (const f of stateful) {
            const b = blockFor(stripBlock(fs.readFileSync(path.join(GEN_DIR, f), 'utf8')), f, genDirRel);
            process.stdout.write(`  ${f.padEnd(18)} ${String(b.items.length).padStart(4)}\n`);
        }
    }
    return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    process.exitCode = main(process.argv.slice(2));
}
