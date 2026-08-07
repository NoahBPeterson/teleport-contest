#!/usr/bin/env node
// lua-oracle.mjs — differential oracle for the Lua->JS script ports (roadmap 1.10).
//
// The transpiled Lua 5.4.8 interpreter stays in the tree precisely so that
// every ported script has a reference implementation to be checked against.
// This tool runs the same session twice in two isolated module graphs —
//
//   A) C2JS_LUA_PORT=0 C2JS_LUA_TRACE=1 : the interpreter runs the real .lua,
//      the registry only observes when each ported script is loaded
//   B) C2JS_LUA_PORT=1                  : the JS port runs instead
//
// — and compares what the game did afterwards: the whole PRNG call log (the
// thing the contest scores), the whole screen sequence, and the RNG-log index
// at which each ported script was loaded (which localises a divergence to
// "before the script" vs "inside the script").
//
// Two graphs, not two processes: js/boot/isolation.mjs's resolve hook gives
// each run a fresh 172-module copy of the transpiled game, so run B does not
// inherit run A's C globals. The judge forbids child processes anyway.
//
// Those graphs are never released, so the process has a budget: roughly 20
// segment graphs on a default heap. Two per session is fine for --all; the
// read-back and quest-probe passes cost two more each, so batch those a few
// sessions at a time (or raise --max-old-space-size).
//
// Usage:
//   node tools/lua-oracle.mjs sessions-extra/gen9996-marathon-dlvl10.session.json
//   node tools/lua-oracle.mjs --seed 8000 --moves ">>>>>>" [--datetime 20260401090000]
//   node tools/lua-oracle.mjs --all sessions/ sessions-extra/     # every session
//   node tools/lua-oracle.mjs --levels=air.lua,fire.lua --seed 8000
//
// --levels=<a.lua,b.lua,…> is the synthetic coverage path: once the game is
// up, both runs build each of those special levels with the game's own
// #wizloaddes calls and compare the resulting level fingerprints. It is how a
// script no recorded session reaches gets an oracle at all — see
// js/lua-js/registry.mjs's C2JS_LUA_LEVELPROBE and NOTES-lua-port.md §7.6.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enableSegmentIsolation, segmentSpecifier } from '../js/boot/isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = pathToFileURL(path.join(ROOT, 'js/boot/harness.mjs')).href;

let segCounter = 0;

/**
 * Boot one segment in its own module graph.
 * @param {object} seg  {seed, datetime, moves, nethackrc}
 * @param {object} env  environment overrides applied for the duration
 */
async function runSegment(seg, env) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
        const spec = segmentSpecifier(HARNESS, ++segCounter, true);
        const { runBootGame } = await import(spec);
        return await runBootGame({
            seed: String(seg.seed),
            datetime: seg.datetime,
            moves: seg.moves,
            nethackrc: seg.nethackrc || '',
            stdoutSink: () => {},
        });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

/**
 * Keys the level probe gets to spend on its own prompts.
 *
 * Building 49 special levels on top of a live game produces messages —
 * des.message(), "You feel a strange vibration", a --More-- after a shop or a
 * temple is filled — and each one waits for a key. Those keys come out of the
 * session's queue, so an unpadded run silently stops probing when the moves
 * run out (the harness treats an exhausted queue as a normal segment end).
 * ESC dismisses a --More-- and a menu alike, and any left over at the end are
 * spent identically by both runs.
 */
const PROBE_KEYS = '\x1b'.repeat(4000);

/** Run every segment of a session and concatenate the observable outputs. */
async function runSession(session, env, pad = false) {
    const rng = [];
    const screens = [];
    const luaLoads = [];
    const stdout = [];
    const source = new Map();
    for (const seg0 of session.segments) {
        const seg = pad ? { ...seg0, moves: (seg0.moves || '') + PROBE_KEYS } : seg0;
        const r = await runSegment(seg, env);
        if (r.error) throw r.error;
        for (const l of r.rngLog) rng.push(l);
        for (const s of r.screens) screens.push(s);
        for (const l of r.luaLoads) luaLoads.push(l);
        for (const [n, c] of r.luaSource?.unported ?? []) source.set(n, (source.get(n) ?? 0) + c);
        stdout.push(r.stdout);
    }
    return { rng, screens, luaLoads, stdout: stdout.join(''), source };
}

/** Strip the "@ caller" suffix the scorer ignores (frozen/ps_test_runner.mjs). */
const normRng = (s) => String(s).replace(/\s*@\s.*$/, '').replace(/^\d+\s+/, '').trim();

function firstDiff(a, b, norm = (x) => x) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (norm(a[i] ?? '\u0000') !== norm(b[i] ?? '\u0000')) return i;
    }
    return -1;
}

/**
 * Compare one session interpreter-vs-port.
 *
 * Runs A and B are the whole oracle for a level script. The read-back scripts
 * (dungeon.lua, quest.lua) need a fifth check, because their entire product is
 * a Lua table that C reads afterwards and neither the RNG log, the screens nor
 * the level fingerprint sees it directly. `--readback` adds two more runs with
 * C2JS_LUA_READBACK=dump, which fingerprints that table — every key and value
 * in lua_next order — at the fclose seam on both sides. `--questprobe` adds two
 * more that deliver quest text for the hero's role, the path no recorded
 * session takes.
 *
 * @param {object} session
 * @param {string} label
 * @param {{readback?: boolean, questprobe?: boolean}} [opts]
 * @returns {object} verdict
 */
export async function compareSession(session, label, opts = {}) {
    // The level probe rides along in the same two runs rather than costing two
    // more graphs: it only adds work after the game is up, and everything it
    // does lands in the RNG log, the screens and the load records that runs A
    // and B already compare.
    const probing = !!(opts.levels && opts.levels.length);
    const probe = probing ? { C2JS_LUA_LEVELPROBE: opts.levels.join(',') } : {};
    const A = await runSession(session, { C2JS_LUA_PORT: '0', C2JS_LUA_TRACE: '1', C2JS_LUA_FP: '1', ...probe }, probing);
    const B = await runSession(session, { C2JS_LUA_PORT: '1', C2JS_LUA_TRACE: '0', C2JS_LUA_FP: '1', ...probe }, probing);

    const rngDiff = firstDiff(A.rng, B.rng, normRng);
    const scrDiff = firstDiff(A.screens, B.screens);
    const loadsMatch = A.luaLoads.length === B.luaLoads.length
        && A.luaLoads.every((l, i) => l.script === B.luaLoads[i].script && l.rngFrom === B.luaLoads[i].rngFrom);
    const fpMatch = A.luaLoads.length === B.luaLoads.length
        && A.luaLoads.every((l, i) => l.typFingerprint === B.luaLoads[i].typFingerprint);

    let questprobe = null;
    if (opts.questprobe) questprobe = await compareQuestProbe(session);
    // With the probe on, the dump runs cover all of the session's quest.lua
    // loads instead of just the legacy one — and each is a fresh nhl_init()
    // state with a fresh hash seed, which is what shows the lua_next order over
    // a hash part is not stable even for the interpreter alone.
    const readback = opts.readback
        ? await compareReadback(session, opts.questprobe ? { C2JS_LUA_QUESTPROBE: '1' } : {},
            opts.questprobe ? null : { A, B })
        : null;

    const levelprobe = opts.levels && opts.levels.length ? summariseProbe(A, B, opts.levels) : null;
    const globals = opts.globals ? await compareGlobals(session, { A, B }) : null;

    return {
        label,
        readback,
        questprobe,
        levelprobe,
        globals,
        // What the interpreter still had to parse, with every port live. The
        // goal state of the roadmap is that this list is empty; §14.5 says what
        // is on it and why.
        source: [...B.source.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        pass: rngDiff < 0 && scrDiff < 0 && loadsMatch && fpMatch && A.rng.length === B.rng.length
            && (readback === null || readback.match) && (questprobe === null || questprobe.match)
            && (levelprobe === null || levelprobe.match) && (globals === null || globals.match),
        fingerprints: {
            match: fpMatch,
            interpreter: A.luaLoads.map((l) => (l.typFingerprint ?? 0).toString(16)),
            port: B.luaLoads.map((l) => (l.typFingerprint ?? 0).toString(16)),
        },
        rng: { interpreter: A.rng.length, port: B.rng.length, firstDiff: rngDiff },
        screens: { interpreter: A.screens.length, port: B.screens.length, firstDiff: scrDiff },
        loads: {
            match: loadsMatch,
            scripts: A.luaLoads.map((l) => `${l.script}@rng${l.rngFrom}`),
            portScripts: B.luaLoads.map((l) => `${l.script}@rng${l.rngFrom}`),
            portRngConsumed: B.luaLoads.map((l) => (l.rngTo >= 0 ? l.rngTo - l.rngFrom : null)),
        },
    };
}

/**
 * The forced-generation oracle: every level named in `--levels` built by both
 * runs through wiz_load_splua()'s own three calls, and fingerprinted.
 *
 * Requires four things per script, and says so per script rather than in
 * aggregate, because "the port was never reached" and "the port matched" look
 * identical in an RNG log:
 *   * the interpreter and the port both actually loaded the .lua (a load
 *     record for it exists between the probe's rng bounds);
 *   * load_special() reported success on both sides;
 *   * the level fingerprint matches — the check §5's statue control showed is
 *     the only one that sees level content the player never looks at;
 *   * the two sides spent the same number of RNG draws building it.
 */
function summariseProbe(A, B, names) {
    const rows = [];
    const probes = (r) => r.luaLoads.filter((l) => l.probe);
    const pa = probes(A), pb = probes(B);
    for (let i = 0; i < names.length; i++) {
        const a = pa[i], b = pb[i];
        const loadedBy = (r, p) => p && r.luaLoads.some(
            (l) => !l.probe && l.script === names[i] && l.rngFrom >= p.rngFrom && l.rngFrom <= p.rngTo);
        // A probe target need not be a *ported* script: S6 forces hellfill.lua,
        // which is still interpreted, precisely to see the ported nhlib serve
        // it. So what is required is that the two sides agree about whether the
        // registry intercepted it, not that it did.
        const ra = !!(a && loadedBy(A, a)), rb = !!(b && loadedBy(B, b));
        const ok = !!a && !!b && a.script === names[i] && b.script === names[i]
            && a.ok && b.ok && ra === rb
            && a.typFingerprint === b.typFingerprint
            && (a.rngTo - a.rngFrom) === (b.rngTo - b.rngFrom);
        rows.push({
            script: names[i], ok,
            built: !!(a && a.ok) && !!(b && b.ok),
            reached: ra && rb,
            interpreted: !ra && !rb,
            fingerprint: [(a?.typFingerprint ?? 0).toString(16), (b?.typFingerprint ?? 0).toString(16)],
            rng: [a ? a.rngTo - a.rngFrom : -1, b ? b.rngTo - b.rngFrom : -1],
        });
    }
    return { match: rows.length === names.length && rows.every((r) => r.ok), rows };
}

/** The read-back records of a run, in load order. */
const rbLoads = (r) => r.luaLoads.filter((l) => l.readbackGlobal);
/** The equivalence the port must satisfy: same table contents, same size. */
const rbKey = (l) => `${l.script}:${l.readbackGlobal}:${(l.readbackHash >>> 0).toString(16)}:${l.readbackValues}`;
/** The lua_next order, which is a property of the state's hash seed, not the data. */
const rbOrder = (l) => `${(l.readbackOrder >>> 0).toString(16)}:${l.readbackKeys.join(',')}`;

/**
 * The read-back oracle: the table each pure-data script leaves for C, hashed
 * key-by-key in lua_next order, interpreter versus port.
 *
 * Both extra runs use C2JS_LUA_READBACK=dump, which also moves the
 * interpreter's chunk execution to the fclose seam (js/lua-js/registry.mjs) so
 * the two dumps are taken at the same instant of the same game. The RNG logs
 * of the dump runs are checked against the plain ones, which is what says the
 * instrumentation itself changed nothing.
 */
async function compareReadback(session, extra, baselines) {
    const dump = { C2JS_LUA_READBACK: 'dump', C2JS_LUA_FP: '1', ...extra };
    const C = await runSession(session, { ...dump, C2JS_LUA_PORT: '0', C2JS_LUA_TRACE: '1' });
    const D = await runSession(session, { ...dump, C2JS_LUA_PORT: '1', C2JS_LUA_TRACE: '0' });
    const ci = rbLoads(C), di = rbLoads(D);
    const match = ci.length > 0 && ci.length === di.length && ci.every((l, i) => rbKey(l) === rbKey(di[i]));
    // dungeon.lua's table is the one C walks with lua_next, and it is a pure
    // sequence, so its traversal order must match too. quest.lua's does not
    // have to and generally will not: see the seed note in js/lua-js/readback.mjs.
    const walked = (l) => l.script === 'dungeon.lua';
    const orderMatch = ci.filter(walked).length === di.filter(walked).length
        && ci.filter(walked).every((l, i) => rbOrder(l) === rbOrder(di.filter(walked)[i]));
    return {
        match: match && orderMatch,
        orderMatch,
        undisturbed: baselines === null ? null
            : firstDiff(baselines.A.rng, C.rng, normRng) < 0 && firstDiff(baselines.B.rng, D.rng, normRng) < 0,
        interpreter: ci.map(rbKey),
        port: di.map(rbKey),
        interpreterOrder: ci.map(rbOrder),
        portOrder: di.map(rbOrder),
        seeds: [ci.map((l) => l.readbackSeed), di.map((l) => l.readbackSeed)],
        values: ci.map((l) => l.readbackValues),
    };
}

/**
 * The library oracle (stage S6): what nhlib.lua and nhcore.lua left in the
 * lua_State, interpreter versus port.
 *
 * A library script's product is a set of *globals* — fourteen functions and a
 * shuffled `align` for nhlib.lua, a hook table and a callback registry for
 * nhcore.lua — and neither the RNG log, the screens nor the level fingerprint
 * sees one of them. nhlib.lua is loaded by every nhl_init(), so a session
 * produces dozens of dumps; each records, per expected global, the Lua type
 * actually found and (for tables) the content hash and lua_next order.
 *
 * Both runs use C2JS_LUA_GLOBALS=dump, which also moves the interpreter's chunk
 * execution to the fclose seam (js/lua-js/registry.mjs) so the two dumps are
 * taken at the same instant of the same game. The RNG logs of the dump runs are
 * checked against the plain ones, which is what says the instrumentation
 * changed nothing — and for nhlib that check is load-bearing, because the two
 * align draws happen inside the window being instrumented.
 */
async function compareGlobals(session, baselines) {
    const dump = { C2JS_LUA_GLOBALS: 'dump' };
    const G = await runSession(session, { ...dump, C2JS_LUA_PORT: '0', C2JS_LUA_TRACE: '1' });
    const H = await runSession(session, { ...dump, C2JS_LUA_PORT: '1', C2JS_LUA_TRACE: '0' });
    const rows = (r) => r.luaLoads.filter((l) => l.globalsScript);
    const key = (l) => `${l.script}[${l.globals.map((g) => `${g.name}:${g.type}`
        + (g.hash === undefined ? '' : `:${(g.hash >>> 0).toString(16)}:${g.values}`)).join(' ')}]`;
    const order = (l) => l.globals.filter((g) => g.order !== undefined)
        .map((g) => `${g.name}:${(g.order >>> 0).toString(16)}`).join(' ');
    const gi = rows(G), hi = rows(H);
    const typesOk = gi.every((l) => l.globals.every((g) => g.type === g.want));
    const match = gi.length > 0 && gi.length === hi.length
        && gi.every((l, i) => key(l) === key(hi[i])) && typesOk;
    const bad = gi.findIndex((l, i) => !hi[i] || key(l) !== key(hi[i]));
    return {
        match,
        typesOk,
        loads: gi.length,
        scripts: [...new Set(gi.map((l) => l.script))],
        // lua_next order over a hash part is seed-derived, so it is reported
        // rather than required — the same treatment questtext gets in §6.2.
        orderMatch: gi.length === hi.length && gi.every((l, i) => order(l) === order(hi[i])),
        // Which tables' lua_next order differs, if any. §6.2: a hash part's
        // order is a property of g->seed, not of the data, so it is reported
        // and attributed rather than required — but an *array* part's is not,
        // and `align` is an array part, so seeing it here would be a bug.
        orderDiffers: [...new Set(gi.flatMap((l, i) => (hi[i] ? l.globals : [])
            .filter((g, k) => g.order !== undefined && g.order !== hi[i].globals[k]?.order)
            .map((g) => g.name)))],
        undisturbed: baselines === undefined ? null
            : firstDiff(baselines.A.rng, G.rng, normRng) < 0
                && firstDiff(baselines.B.rng, H.rng, normRng) < 0,
        first: bad < 0 ? null : { interpreter: key(gi[bad]), port: hi[bad] ? key(hi[bad]) : '(no such load)' },
        sample: gi.length ? key(gi[0]) : '',
    };
}

/**
 * The quest-delivery oracle: with C2JS_LUA_QUESTPROBE=1 the registry calls
 * qt_pager() for five message ids in the hero's own role section and
 * com_pager() for two `common` ones, once the game is up. Each is a complete
 * com_pager_core() — a fresh nhl_init(), a fresh load of quest.lua, a
 * lua_getfield walk and a delivery — so the comparison is of the text the
 * player would actually have seen.
 *
 * The comparison is of the raw terminal byte stream, not of the sampled
 * screens. A `--More--`-paged quest window is drawn and dismissed inside a
 * single key wait, so it never lands on an input-boundary screen at all: the
 * screen sequence would have compared equal no matter what the text said. The
 * stdout stream contains every byte the window port emitted, quest prose
 * included.
 */
async function compareQuestProbe(session) {
    const probe = { C2JS_LUA_QUESTPROBE: '1' };
    const E = await runSession(session, { ...probe, C2JS_LUA_PORT: '0', C2JS_LUA_TRACE: '1' });
    const F = await runSession(session, { ...probe, C2JS_LUA_PORT: '1', C2JS_LUA_TRACE: '0' });
    const outDiff = E.stdout === F.stdout ? -1
        : [...E.stdout].findIndex((c, i) => c !== F.stdout[i]);
    const rngDiff = firstDiff(E.rng, F.rng, normRng);
    return {
        match: outDiff < 0 && rngDiff < 0 && E.stdout.length === F.stdout.length,
        bytes: E.stdout.length,
        firstDiff: outDiff,
        rngFirstDiff: rngDiff,
        questLoads: E.luaLoads.filter((l) => l.script === 'quest.lua').length,
    };
}

function printVerdict(v) {
    const mark = v.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${v.label}`);
    console.log(`      rng     interpreter=${v.rng.interpreter} port=${v.rng.port} firstDiff=${v.rng.firstDiff}`);
    console.log(`      screens interpreter=${v.screens.interpreter} port=${v.screens.port} firstDiff=${v.screens.firstDiff}`);
    // A level-probe run loads a hundred scripts; the per-script table below
    // says everything the full lists would, so elide them past a dozen.
    const brief = (a) => (a.length <= 12 ? a.join(', ') : `${a.length} loads: ${a.slice(0, 4).join(', ')}, …, ${a[a.length - 1]}`);
    console.log(`      ported-script loads: ${v.loads.scripts.length ? brief(v.loads.scripts) : '(none reached)'}`);
    if (v.loads.portScripts.length) {
        console.log(`      port loads:          ${brief(v.loads.portScripts)}`);
        if (v.loads.portScripts.length <= 12) {
            console.log(`      rng draws inside port: ${JSON.stringify(v.loads.portRngConsumed)}`);
        }
        const fp = v.fingerprints;
        console.log(`      level fingerprint:   ${fp.match ? 'MATCH' : 'MISMATCH'}`
            + (fp.interpreter.length <= 12 ? ` interpreter=${fp.interpreter.join(',')} port=${fp.port.join(',')}` : ''));
        if (!fp.match) {
            for (let i = 0; i < Math.max(fp.interpreter.length, fp.port.length); i++) {
                if (fp.interpreter[i] !== fp.port[i]) {
                    console.log(`        [${i}] ${v.loads.scripts[i]}: interpreter=${fp.interpreter[i]} port=${fp.port[i]}`);
                }
            }
        }
    }
    if (v.readback) {
        const rb = v.readback;
        console.log(`      read-back table:     ${rb.match ? 'MATCH' : 'MISMATCH'} `
            + `(${rb.values.join('/')} values hashed; lua_next order over the walked table `
            + `${rb.orderMatch ? 'MATCH' : 'MISMATCH'}; instrumentation `
            + `${rb.undisturbed === null ? 'not compared (probe runs)'
                : rb.undisturbed ? 'undisturbed' : 'PERTURBED THE RUN'})`);
        for (let i = 0; i < Math.max(rb.interpreter.length, rb.port.length); i++) {
            const a = rb.interpreter[i], b = rb.port[i];
            if (a !== b) console.log(`        [${i}] interpreter=${a}\n            port       =${b}`);
            else console.log(`        [${i}] ${a}`);
            if (rb.interpreterOrder[i] !== rb.portOrder[i]) {
                console.log(`            lua_next order differs (seed ${rb.seeds[0][i]} vs ${rb.seeds[1][i]}):`);
                console.log(`              interpreter ${rb.interpreterOrder[i]}`);
                console.log(`              port        ${rb.portOrder[i]}`);
            }
        }
    }
    if (v.levelprobe) {
        const lp = v.levelprobe;
        console.log(`      forced level generation: ${lp.match ? 'MATCH' : 'MISMATCH'} (${lp.rows.length} scripts)`);
        for (const r of lp.rows) {
            console.log(`        ${r.ok ? 'ok  ' : 'FAIL'} ${r.script.padEnd(14)} `
                + `fp ${r.fingerprint[0]}/${r.fingerprint[1]} rng ${r.rng[0]}/${r.rng[1]}`
                + `${r.built ? '' : ' NOT-BUILT'}`
                + `${r.reached || r.interpreted ? '' : ' PORT-NOT-REACHED'}`
                + `${r.interpreted ? ' (still interpreted)' : ''}`);
        }
    }
    if (v.globals) {
        const g = v.globals;
        console.log(`      library globals:     ${g.match ? 'MATCH' : 'MISMATCH'} `
            + `(${g.loads} loads of ${g.scripts.join('+')}; every global the expected type: `
            + `${g.typesOk ? 'yes' : 'NO'}; lua_next order ${g.orderMatch ? 'MATCH'
                : `differs for ${g.orderDiffers.join(',')}`}; `
            + `instrumentation ${g.undisturbed === null ? 'not compared'
                : g.undisturbed ? 'undisturbed' : 'PERTURBED THE RUN'})`);
        if (g.first) {
            console.log(`        interpreter=${g.first.interpreter}`);
            console.log(`        port       =${g.first.port}`);
        } else if (g.sample) {
            console.log(`        ${g.sample}`);
        }
    }
    if (v.source) {
        console.log(`      .lua still parsed:   ${v.source.length === 0 ? 'NONE'
            : v.source.map(([n, c]) => `${n}\u00d7${c}`).join(', ')}`);
    }
    if (v.questprobe) {
        console.log(`      quest-text delivery: ${v.questprobe.match ? 'MATCH' : 'MISMATCH'} `
            + `(${v.questprobe.questLoads} quest.lua loads, ${v.questprobe.bytes} terminal bytes, `
            + `firstDiff=${v.questprobe.firstDiff}, rngFirstDiff=${v.questprobe.rngFirstDiff})`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (!(await enableSegmentIsolation())) {
        console.error('lua-oracle: segment isolation unavailable (needs Node with module.registerHooks)');
        process.exit(2);
    }

    const levelsArg = argv.find((a) => a.startsWith('--levels='));
    const opts = {
        readback: argv.includes('--readback'),
        globals: argv.includes('--globals'),
        questprobe: argv.includes('--questprobe'),
        levels: levelsArg ? levelsArg.slice('--levels='.length).split(',').filter(Boolean) : [],
    };
    let sessions = [];
    const seedAt = argv.indexOf('--seed');
    if (seedAt >= 0) {
        const seed = argv[seedAt + 1];
        const get = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
        // --rc=<text> writes a .nethackrc for the synthetic segment. It is how
        // a script behind an *option* rather than behind a dungeon branch gets
        // reached in ordinary play: `--rc='OPTIONS=tutorial'` makes
        // ask_do_tutorial() (options.c:430) answer yes without a menu, so
        // maybe_do_tutorial() (allmain.c:568) teleports the hero into tut-1 as
        // the very first thing the game does. See NOTES-lua-port.md §14.1.
        const rc = (get('--rc', '') || '').replace(/\\n/g, '\n');
        sessions = [{
            name: `seed${seed}${rc ? ` [${rc.replace(/\n/g, '; ')}]` : ''}`,
            segments: [{
                seed, datetime: get('--datetime', '20260401090000'),
                moves: get('--moves', '  '),
                nethackrc: rc && !rc.endsWith('\n') ? `${rc}\n` : rc,
            }],
        }];
    } else {
        const files = [];
        const walk = (p) => {
            if (fs.statSync(p).isDirectory()) {
                for (const f of fs.readdirSync(p).sort()) if (f.endsWith('.session.json')) files.push(path.join(p, f));
            } else files.push(p);
        };
        for (const a of argv) if (!a.startsWith('--')) walk(path.resolve(ROOT, a));
        sessions = files.map((f) => ({ name: path.basename(f), ...JSON.parse(fs.readFileSync(f, 'utf8')) }));
    }

    let bad = 0;
    for (const s of sessions) {
        let v;
        try { v = await compareSession(s, s.name, opts); }
        catch (e) { console.log(`ERROR ${s.name}: ${e.message}`); console.log(e.stack ?? e); bad++; continue; }
        printVerdict(v);
        if (!v.pass) bad++;
    }
    console.log(`\n${sessions.length - bad}/${sessions.length} sessions equivalent (interpreter vs port)`);
    process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
