#!/usr/bin/env node
// reset-diff.mjs — prove that resetting a module graph is indistinguishable
// from forking a new one.
//
// THE CLAIM UNDER TEST. `run session A to completion, reset, run session B`
// produces output byte-identical to `run B in a fresh realm`. Everything the
// judge scores is in that comparison — screens, cursor positions, the RNG call
// log, the supplemental animation frames — plus stdout and the exit code, which
// it does not score but which would betray a divergence earlier.
//
// WHY A DIFFERENTIAL AND NOT THE CORPUS. The corpus (frozen/ps_test_runner.mjs)
// compares against what the C recorder produced, so it can only catch a reset
// bug that changes an *observable the recorder recorded*. This compares against
// the port's own fresh-realm output, which is the actual specification of a
// reset: not "still plays NetHack correctly" but "is the same realm". It also
// catches divergence in sessions the recorder never covered, and it localises —
// it reports the first differing screen/cursor/RNG line rather than a score.
//
// THE REFERENCE IS THE FORK PATH. Reference runs go through
// isolation.mjs's `?c2jsseg=N`, one fresh graph per segment, which is exactly
// what js/jsmain.js:runSegment does today and what the 69/69 corpus certifies.
// Reference and test run in the same process on purpose: a forked graph is
// independent of every other graph (its own cptr.js, its own everything), so
// same-process reference is sound, and it makes the two paths share a machine,
// a heap and a JIT state — the strongest way to attribute a difference to the
// reset rather than to the environment.
//
// RED BEFORE GREEN. On a build without C2JS_RESET=1 there are no reset
// functions, `Realm.reset()` returns false, and this tool reports every pair as
// UNRESETTABLE — a build that cannot even attempt the thing. Use --force-noop
// to make it attempt it anyway with reset as a literal no-op: that is the red
// evidence, and every pair must FAIL. A harness that cannot fail on a
// deliberately broken reset is not evidence of anything.
//
// THROUGH THE REAL PATH. `--via runsegment` drives the test side through
// js/jsmain.js's exported `runSegment` — the function the judge calls — instead
// of through js/boot/reset-realm.mjs directly. That is a different claim and a
// stronger one: not "a reset realm reproduces a fresh realm" but "the entry
// point reproduces a fresh realm", which additionally covers how runSegment
// acquires the realm, when it decides to reset, what it does with the result
// object, and its fallback. The observable narrows to exactly what runSegment
// exposes — screens, cursors, animation frames, the RNG log, and a thrown
// error — because stdout and the exit code are not on that interface; both
// sides are masked identically so the comparison stays honest about it.
//
// USAGE
//   node tools/reset-diff.mjs                      # the default pair set
//   node tools/reset-diff.mjs --pairs A:B,B:B      # explicit pairs (A then B)
//   node tools/reset-diff.mjs --self A,B,C         # self-pairs A:A, B:B, ...
//   node tools/reset-diff.mjs --via runsegment     # test side via js/jsmain.js
//   node tools/reset-diff.mjs --build yield        # js/generated-y (see below)
//   node tools/reset-diff.mjs --force-noop         # reset := no-op (red proof)
//   node tools/reset-diff.mjs --json out.json      # machine-readable result
//   node tools/reset-diff.mjs --quiet              # only the verdict table
//
// BOTH BUILDS. `--build yield` runs the whole thing against js/generated-y/ —
// tools/c2js/yieldify.mjs's rewrite, which js/boot/main-thread-engine.mjs plays
// interactively and which now serves a whole corpus out of one reset realm.
// Its reset blocks come from the same pass over a differently shaped source
// (4,666 of its functions are generators), so "the sync build's reset is exact"
// is not evidence about it. Reference and test both use that build, so what is
// being compared is still reset-vs-fork and not yield-vs-sync — the corpus
// already certifies the transform itself, byte-exact, 69/69.
//
// RUN `--build yield` ONE PAIR PER PROCESS. The REFERENCE side forks a graph
// per segment, and a yieldable graph is ~190 MB of unloadable module map
// against the sync build's ~70 MB. The default twelve pairs need seventeen of
// them, and the run stops making progress somewhere past the eighth — 380% CPU
// in GC against a 1.5 GB live set, which is exactly the pathology this whole
// page exists to remove, met here in the one place that cannot use the cure.
// Per pair it is 10-20 s:
//
//   for p in seed0030:seed0030 seed8000:seed0030 seed0030:seed4500; do
//     node --max-old-space-size=8192 tools/reset-diff.mjs --build yield --pairs $p
//   done
//
// Session names are matched against sessions/ and sessions-extra/ by prefix,
// so `seed0013` finds `seed0013-friday13-save-then-fullmoon-restore`.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SESSION_DIRS = ['sessions', 'sessions-extra'];

// ---------------------------------------------------------------- sessions --

function discoverSessions() {
    const out = new Map();
    for (const d of SESSION_DIRS) {
        let names;
        try { names = readdirSync(join(ROOT, d)); } catch { continue; }
        for (const f of names) {
            if (!f.endsWith('.session.json')) continue;
            out.set(f.replace(/\.session\.json$/, ''), join(ROOT, d, f));
        }
    }
    return out;
}

function resolveSession(all, spec) {
    if (all.has(spec)) return spec;
    const hits = [...all.keys()].filter((k) => k.startsWith(spec));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) throw new Error(`no session matches "${spec}"`);
    throw new Error(`"${spec}" is ambiguous: ${hits.join(', ')}`);
}

async function loadSegments(path) {
    const { normalizeSession } = await import(
        pathToFileURL(join(ROOT, 'frozen/session_loader.mjs')).href);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return normalizeSession(raw).segments.map((s) => ({
        seed: s.seed, datetime: s.datetime,
        nethackrc: s.nethackrc || '', moves: s.moves || '',
    }));
}

// Web-Storage shape, one per session, exactly as frozen/ps_test_runner.mjs
// builds it — cross-segment save/bones/record state flows through here.
function makeStorage() {
    const m = new Map();
    return {
        getItem(k) { return m.has(k) ? m.get(k) : null; },
        setItem(k, v) { m.set(k, String(v)); },
        removeItem(k) { m.delete(k); },
        get length() { return m.size; },
        key(i) { let n = 0; for (const k of m.keys()) { if (n === i) return k; n++; } return null; },
    };
}

// ----------------------------------------------------------- the observable --
//
// Everything a caller could see of a segment. `error` is folded in as its
// message: a run that throws where the reference did not is a divergence, and
// silently comparing two failed runs as "equal" would be the worst possible
// bug in a tool whose whole job is to notice.

function observe(result) {
    return {
        screens: (result.screens || []).slice(),
        cursors: (result.cursors || []).map((c) => (Array.isArray(c) ? c.slice() : c)),
        anim: (result.animFramesByStep || []).map((a) => (Array.isArray(a) ? a.slice() : a)),
        rng: (result.rngLog || []).slice(),
        stdout: result.stdout == null ? '' : String(result.stdout),
        exitCode: result.exitCode === undefined ? null : result.exitCode,
        error: result.error ? String(result.error.message || result.error) : null,
    };
}

/**
 * First point at which two segment observations differ, described in words.
 * Returns null when they are identical.
 */
function firstDiff(a, b) {
    for (const field of ['error', 'exitCode', 'stdout']) {
        if (a[field] !== b[field]) {
            return { field, index: null, ref: str(a[field]), got: str(b[field]) };
        }
    }
    for (const [field, key] of [['rng', 'rng'], ['screens', 'screens'], ['cursors', 'cursors'], ['anim', 'anim']]) {
        const x = a[key], y = b[key];
        const n = Math.max(x.length, y.length);
        for (let i = 0; i < n; i++) {
            const xi = JSON.stringify(x[i]), yi = JSON.stringify(y[i]);
            if (xi !== yi) {
                return {
                    field, index: i,
                    counts: `ref ${x.length} / got ${y.length}`,
                    ref: str(xi), got: str(yi),
                };
            }
        }
    }
    return null;
}

function str(v) {
    const s = v === null || v === undefined ? String(v) : String(v);
    return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

/** Compare whole sessions (arrays of segment observations). */
function diffSession(ref, got) {
    if (ref.length !== got.length) {
        return { segment: null, field: 'segment count', ref: String(ref.length), got: String(got.length) };
    }
    for (let i = 0; i < ref.length; i++) {
        const d = firstDiff(ref[i], got[i]);
        if (d) return { segment: i, ...d };
    }
    return null;
}

function tally(obs) {
    let screens = 0, rng = 0, anim = 0;
    for (const o of obs) {
        screens += o.screens.length; rng += o.rng.length;
        for (const a of o.anim) anim += Array.isArray(a) ? a.length : 0;
    }
    return { segments: obs.length, screens, rng, anim };
}

// -------------------------------------------------------------- run modes ---

/**
 * Reference: every segment in its own freshly forked graph. This is
 * js/jsmain.js:runSegment's Node path, spelled out.
 */
async function runForked(segments, ctx) {
    const storage = makeStorage();
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        const realm = await ctx.acquire();
        const r = await realm.runBootGame({ ...segments[i], storage });
        out.push(observe(r));
        ctx.forks++;
    }
    return out;
}

/**
 * Test, through the entry point: every segment handed to js/jsmain.js's
 * `runSegment` exactly as the judge hands it over, in one process, so that
 * runSegment's own process-wide realm is what serves them.
 *
 * runSegment throws on a game error rather than returning one, and exposes no
 * stdout or exit code, so what comes back here is the judge's own view of a
 * segment and nothing more. maskJudgeView() below narrows the REFERENCE to the
 * same view; if it did not, every pair would "fail" on a field neither side
 * could see.
 */
async function runViaRunSegment(runSegment, segments) {
    const storage = makeStorage();
    const out = [];
    for (const s of segments) {
        let r;
        try {
            const g = await runSegment({ ...s, storage });
            r = {
                screens: g.getScreens(), cursors: g.getCursors(),
                animFramesByStep: g.getAnimationFramesByStep(), rngLog: g.getRngLog(),
            };
        } catch (e) {
            r = { error: e };
        }
        out.push(maskJudgeView(observe(r)));
    }
    return out;
}

/** Blank the two fields runSegment's interface does not carry. */
function maskJudgeView(o) { return { ...o, stdout: '', exitCode: null }; }

/**
 * Test: every segment in the SAME graph, reset in between — including between
 * the segments of one session, which is the part that replaces the fork.
 */
async function runInRealm(realm, segments, ctx) {
    const storage = makeStorage();
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        if (realm.generation > 0) {
            const t0 = performance.now();
            const ok = realm.reset();
            const ms = performance.now() - t0;
            if (!ok) throw new Error('realm refused to reset');
            ctx.resets.push(ms);
        }
        realm.generation++;
        const r = await realm.runBootGame({ ...segments[i], storage });
        out.push(observe(r));
    }
    return out;
}

// ------------------------------------------------------------------- main ---

function parseArgs(argv) {
    const o = { pairs: null, self: null, json: null, quiet: false, forceNoop: false, list: false, via: 'realm', build: 'sync' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--quiet') o.quiet = true;
        else if (a === '--force-noop') o.forceNoop = true;
        else if (a === '--list') o.list = true;
        else if (a === '--json') o.json = argv[++i];
        else if (a === '--pairs') o.pairs = argv[++i];
        else if (a === '--self') o.self = argv[++i];
        else if (a === '--via') o.via = argv[++i];
        else if (a === '--build') o.build = argv[++i];
        else if (a.startsWith('--build=')) o.build = a.slice(8);
        else if (a.startsWith('--pairs=')) o.pairs = a.slice(8);
        else if (a.startsWith('--self=')) o.self = a.slice(7);
        else if (a.startsWith('--json=')) o.json = a.slice(7);
        else if (a.startsWith('--via=')) o.via = a.slice(6);
        else throw new Error(`unknown argument: ${a}`);
    }
    if (o.via !== 'realm' && o.via !== 'runsegment') {
        throw new Error(`--via must be "realm" or "runsegment", not "${o.via}"`);
    }
    if (o.build !== 'sync' && o.build !== 'yield') {
        throw new Error(`--build must be "sync" or "yield", not "${o.build}"`);
    }
    if (o.build === 'yield' && o.via === 'runsegment') {
        // runSegment is the scored path and the scored path is the sync build.
        // Silently ignoring one of the two flags would be the wrong answer.
        throw new Error('--via runsegment always uses the sync build; drop --build yield');
    }
    return o;
}

// The default set. Chosen for variety of role, dungeon and shape rather than
// for size: a self-pair (the weakest possible reset still has to survive it),
// cross-role, cross-dungeon-branch, and both multi-segment acid tests — the
// save/restore pair and the ten-segment marathon, which are the only sessions
// where a reset has to stand in for a fork *inside* one session.
const DEFAULT_PAIRS = [
    ['seed8000', 'seed8000'],   // self-pair: the floor
    ['seed8000', 'seed4500'],   // short then long
    ['seed4500', 'seed8000'],   // long then short
    ['seed0002', 'seed0006'],   // healer -> wizard
    ['seed0006', 'seed0002'],   // and back
    ['seed0004', 'seed0007'],   // pony -> rogue/swamp
    ['seed0007', 'seed0013-friday13'],   // -> acid test 1 (save/restore, 2 segments)
    ['seed0013-friday13', 'seed0013-friday13'],   // acid test 1, self-paired
    ['seed8000', 'seed0030'],   // -> acid test 2 (ten segments)
    ['seed0030', 'seed0030'],   // acid test 2, self-paired
    ['seed0030', 'seed4500'],   // ten segments then a long single
    ['seed0013-friday13', 'seed0030'],   // both acid tests, back to back
];

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const all = discoverSessions();

    if (opts.list) {
        for (const k of [...all.keys()].sort()) process.stdout.write(k + '\n');
        return 0;
    }

    let pairs;
    if (opts.self) pairs = opts.self.split(',').map((s) => [s.trim(), s.trim()]);
    else if (opts.pairs) {
        pairs = opts.pairs.split(',').map((p) => {
            const [a, b] = p.split(':');
            if (!a || !b) throw new Error(`bad pair "${p}" (want A:B)`);
            return [a.trim(), b.trim()];
        });
    } else pairs = DEFAULT_PAIRS;

    pairs = pairs.map(([a, b]) => [resolveSession(all, a), resolveSession(all, b)]);

    const { installBrowserGlobals } = await import(
        pathToFileURL(join(ROOT, 'js/boot/browser-env.mjs')).href);
    installBrowserGlobals();
    const resetRealm = await import(pathToFileURL(join(ROOT, 'js/boot/reset-realm.mjs')).href);

    // Reference realms are acquired UNARMED: no snapshot, nothing this file
    // adds. That makes a reference realm bit-for-bit the thing
    // js/jsmain.js:runSegment acquires today, so the reference cannot be
    // contaminated by the machinery under test.
    const ctx = { forks: 0, resets: [], acquire: () => resetRealm.acquire({ arm: false, build: opts.build }) };

    // Is this build able to reset at all? Ask once, cheaply, before spending
    // minutes on reference runs.
    const probe = await resetRealm.acquire({ build: opts.build });
    const resettable = probe.resettable;
    if (!resettable && !opts.forceNoop) {
        process.stdout.write(
            'reset-diff: this build has no reset functions (js/generated/__reset.js\n'
            + 'is absent — build with C2JS_RESET=1). Re-run with --force-noop to\n'
            + 'exercise the harness against a no-op reset, which MUST fail.\n');
        return 2;
    }
    if (opts.forceNoop) {
        // Deliberately break it: reset becomes a no-op that reports success.
        // Every pair must now fail, and the ones that do not are telling us the
        // observable is too weak.
        resetRealm.Realm.prototype.reset = function reset() { this.lastResetMs = 0; this._dirty = false; return true; };
    }

    const segCache = new Map();
    const segsFor = async (name) => {
        if (!segCache.has(name)) segCache.set(name, await loadSegments(all.get(name)));
        return segCache.get(name);
    };

    // The entry point, in the mode that tests it. Imported by path so that it
    // and this file resolve js/boot/reset-realm.mjs to the same module — which
    // is what makes --force-noop's prototype patch reach runSegment's realm too.
    const runSegment = opts.via === 'runsegment'
        ? (await import(pathToFileURL(join(ROOT, 'js/jsmain.js')).href)).runSegment
        : null;

    // Reference digests, computed once per session and reused across pairs.
    const refCache = new Map();
    const referenceFor = async (name) => {
        if (!refCache.has(name)) {
            const t0 = performance.now();
            let obs = await runForked(await segsFor(name), ctx);
            if (runSegment) obs = obs.map(maskJudgeView);
            if (!opts.quiet) {
                const t = tally(obs);
                process.stdout.write(`  reference ${name}: ${t.segments} seg, ${t.screens} screens, `
                    + `${t.rng} rng, ${t.anim} anim  (${Math.round(performance.now() - t0)} ms)\n`);
            }
            refCache.set(name, obs);
        }
        return refCache.get(name);
    };

    // ONE realm for every pair. That is the claim being tested — a realm that
    // serves unlimited games — and testing it with a fresh realm per pair would
    // quietly weaken the harness to "two games per graph". A realm is replaced
    // only after a failure, so pair k+1 is not judged on pair k's wreckage.
    const rows = [];
    let failures = 0;
    let realm = probe.resettable || opts.forceNoop ? probe : await resetRealm.acquire({ build: opts.build });
    for (const [a, b] of pairs) {
        const label = `${short(a)} -> ${short(b)}`;
        if (!opts.quiet) process.stdout.write(`\n[pair] ${label}\n`);
        const ref = await referenceFor(b);

        const before = ctx.resets.length;
        let got = null, err = null;
        const t0 = performance.now();
        try {
            if (runSegment) {
                await runViaRunSegment(runSegment, await segsFor(a));   // session A, discarded
                got = await runViaRunSegment(runSegment, await segsFor(b)); // session B, compared
            } else {
                await runInRealm(realm, await segsFor(a), ctx);   // session A, discarded
                got = await runInRealm(realm, await segsFor(b), ctx); // session B, compared
            }
        } catch (e) {
            err = e;
        }
        const ms = Math.round(performance.now() - t0);
        const resetMs = ctx.resets.slice(before);

        let verdict, detail = '';
        if (err) { verdict = 'ERROR'; detail = err.message; }
        else {
            const d = diffSession(ref, got);
            if (d === null) verdict = 'PASS';
            else {
                verdict = 'FAIL';
                detail = d.segment === null
                    ? `${d.field}: reference ${d.ref}, reset ${d.got}`
                    : `segment ${d.segment} ${d.field}[${d.index}]`
                      + (d.counts ? ` (${d.counts})` : '')
                      + `\n      reference: ${d.ref}\n      reset:     ${d.got}`;
            }
        }
        // A fresh realm after a failure, so pair k+1 is not judged on pair k's
        // wreckage. Not in runsegment mode: the realm belongs to js/jsmain.js
        // and replacing it here would be testing something else.
        if (verdict !== 'PASS') { failures++; if (!runSegment) realm = await resetRealm.acquire({ build: opts.build }); }
        if (!opts.quiet) {
            // In runsegment mode the resets happen inside js/jsmain.js and this
            // tool never sees them, so it says so rather than printing a `0`
            // that reads like "no reset happened".
            process.stdout.write(`  ${verdict}${detail ? ': ' + detail : ''}  (${ms} ms, `
                + (runSegment ? 'resets internal to runSegment' : `${resetMs.length} resets`) + ')\n');
        }
        rows.push({ a, b, verdict, detail, ms, resets: resetMs });
    }

    // ---- verdict table
    const w = Math.max(...rows.map((r) => (short(r.a) + ' -> ' + short(r.b)).length), 4);
    process.stdout.write('\n' + 'pair'.padEnd(w) + '  verdict\n');
    process.stdout.write('-'.repeat(w) + '  -------\n');
    for (const r of rows) {
        process.stdout.write((short(r.a) + ' -> ' + short(r.b)).padEnd(w) + '  ' + r.verdict + '\n');
    }
    const allResets = ctx.resets;
    if (allResets.length) {
        const sorted = [...allResets].sort((x, y) => x - y);
        const med = sorted[sorted.length >> 1];
        process.stdout.write(`\nresets: ${allResets.length}, median ${med.toFixed(1)} ms, `
            + `min ${sorted[0].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms\n`);
    }
    process.stdout.write(`forked reference graphs: ${ctx.forks}\n`);
    process.stdout.write(`${rows.length - failures}/${rows.length} pairs byte-identical to a fresh realm\n`);

    if (opts.json) {
        writeFileSync(opts.json, JSON.stringify({
            forceNoop: opts.forceNoop, resettable, rows,
            resets: allResets, forks: ctx.forks,
        }, null, 2));
    }

    if (opts.forceNoop) {
        // Inverted expectation: the no-op run is evidence only if it fails.
        process.stdout.write(failures === rows.length
            ? '\n--force-noop: every pair failed, as it must. The harness can see a broken reset.\n'
            : `\n--force-noop: ${rows.length - failures} pair(s) PASSED with a no-op reset. `
              + 'The observable is too weak to be evidence.\n');
        return failures === rows.length ? 0 : 1;
    }
    return failures === 0 ? 0 : 1;
}

function short(name) { return name.split('-')[0]; }

process.exitCode = await main();
