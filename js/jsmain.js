// jsmain.js — Contest entry point: runSegment for the judge harness.
//
// The judge calls runSegment(input) once per session segment with
// { seed, datetime, nethackrc, moves, storage } and reads back
// game.getScreens() / getRngLog() / getCursors() /
// getAnimationFramesByStep() to compare with C-recorded session data.
//
// The game is the clang-AST→JS transpiled NetHack 5.0 corpus
// (js/generated/*). Everything runs in *this* process: the judge sandboxes
// us with `node --permission` (no child processes, no worker threads, no
// filesystem writes, reads confined to the fork tree), and the same code has
// to be able to run in a browser. So:
//
//   - per-segment isolation in Node comes from js/boot/isolation.mjs, which
//     forks a fresh copy of the whole transpiled module graph per segment
//     instead of a fresh process (see that file for why the naive `?seg=`
//     trick isn't enough);
//   - per-segment isolation in a browser comes from running segments 2..N in a
//     module Worker (js/boot/frame.mjs) — a fresh realm has a fresh module map,
//     so the generated corpus re-initialises. Segment 1 uses the page's own
//     realm, which is pristine. If Workers are unavailable the segment falls
//     back to the shared graph with a console warning;
//   - browsers have no `process`, which two libc shims still reach for, so
//     js/boot/browser-env.mjs installs a minimal one before the first
//     generated module runs;
//   - the game's data files are vendored as JS modules under data/ and served
//     by an in-memory VFS in js/boot/harness.mjs — no real filesystem at all;
//   - cross-segment persistence flows through input.storage (the judge's
//     Web-Storage-shaped handle) via that VFS overlay.
//
// C2JS_SPAWN=1 restores the old one-child-process-per-segment path
// (tools/segment-spawn.mjs + js/boot/worker.mjs) for local debugging. It is
// deliberately not reachable from this file's module graph — the judge must
// never be able to take it.
//
// The original hand-written skeleton engine lives on under js/legacy/.

import { enableSegmentIsolation, segmentSpecifier } from './boot/isolation.mjs';
import { installBrowserGlobals } from './boot/browser-env.mjs';

// Captured before installBrowserGlobals() can fake a `process` into existence.
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

const HARNESS_URL = new URL('./boot/harness.mjs', import.meta.url).href;
const FRAME_URL = new URL('./boot/frame.mjs', import.meta.url).href;

let segmentCount = 0;
let spawnFallback;
// null = untried, true = module Workers give us fresh realms, false = they don't
// (no Worker constructor, CSP worker-src, module-worker support missing …) and
// later segments have to share this realm's graph.
let realmForking = null;

class TranspiledGame {
    constructor(result) {
        this._result = result;
    }
    getScreens() { return this._result.screens || []; }
    getCursors() { return this._result.cursors || []; }
    getRngLog() { return this._result.rngLog || []; }
    getAnimationFramesByStep() { return this._result.animFramesByStep || []; }
}

function wantSpawn() {
    return IS_NODE && process.env && process.env.C2JS_SPAWN === '1';
}

// -- browser per-segment isolation -------------------------------------------
// Node forks the module graph in-process (js/boot/isolation.mjs). A browser has
// no module.registerHooks, but it has something better: a module Worker is a
// fresh realm with a fresh module map, so importing harness.mjs inside one
// re-instantiates all 172 generated modules with their C globals at their
// static initialisers. js/boot/frame.mjs is that worker.
//
// Segment 1 runs in *this* realm — it is pristine on first use, so forking for
// it would only cost a second 15 MB parse (and 40 of 44 public sessions are
// single-segment). Segments 2..N each get their own worker.

function snapshotStorage(h) {
    const o = {};
    if (!h) return o;
    const n = h.length || 0;
    for (let i = 0; i < n; i++) {
        const k = h.key(i);
        if (k != null) o[k] = h.getItem(k);
    }
    return o;
}

function applyStorage(h, before, after) {
    if (!h) return;
    for (const k of Object.keys(after)) {
        if (before[k] !== after[k]) h.setItem(k, after[k]);
    }
    for (const k of Object.keys(before)) {
        if (!(k in after)) h.removeItem(k);
    }
}

/** Thrown when the *realm* could not be created — never for a game error. */
class RealmUnavailable extends Error {}

function runInFreshRealm(job) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(FRAME_URL, { type: 'module', name: 'c2js-seg' });
        } catch (e) {
            return reject(new RealmUnavailable(String((e && e.message) || e)));
        }
        let started = false;
        const done = (fn, arg) => {
            try { worker.terminate(); } catch {}
            fn(arg);
        };
        // A worker that dies before it ever ran the job means the realm is
        // unusable (CSP, no module-worker support): degrade. A worker that dies
        // after the job started is a real crash and must surface as one.
        worker.onerror = (e) => done(reject, started
            ? new Error('segment worker error: ' + (e && (e.message || e.type)))
            : new RealmUnavailable(String((e && e.message) || 'worker failed to start')));
        worker.onmessageerror = () => done(reject, new RealmUnavailable('worker message could not be deserialised'));
        worker.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'ready') {
                started = true;
                worker.postMessage({ type: 'run', job });
                return;
            }
            if (msg.type !== 'done') return;
            if (!msg.ok) return done(reject, new Error(msg.error));
            done(resolve, msg);
        };
    });
}

export async function runSegment(input) {
    const n = ++segmentCount;
    const job = {
        seed: input.seed,
        datetime: input.datetime,
        nethackrc: input.nethackrc || '',
        moves: input.moves || '',
        storage: input.storage || null,
    };

    if (wantSpawn()) {
        // Debug escape hatch; lives outside js/ so the sandboxed path stays
        // free of node:child_process.
        if (!spawnFallback) {
            spawnFallback = await import(new URL('../tools/segment-spawn.mjs', import.meta.url).href);
        }
        return new TranspiledGame(await spawnFallback.runSegmentInChild(job));
    }

    // Browser, segment 2+: run in a throwaway realm so the previous segment's C
    // globals cannot leak in. Never for segment 1 (this realm is already fresh),
    // never in Node (isolation.mjs does it in-process, cheaper and proven).
    if (!IS_NODE && n > 1 && realmForking !== false) {
        const before = snapshotStorage(job.storage);
        try {
            const msg = await runInFreshRealm({ ...job, storage: before });
            realmForking = true;
            applyStorage(job.storage, before, msg.storage || {});
            return new TranspiledGame(msg.result);
        } catch (e) {
            if (!(e instanceof RealmUnavailable)) throw e;
            realmForking = false;
            warnSharedRealm(e.message);
            // fall through to the shared-graph path below
        }
    }

    installBrowserGlobals();
    const isolated = await enableSegmentIsolation();
    const { runBootGame } = await import(segmentSpecifier(HARNESS_URL, n, isolated));
    const result = await runBootGame(job);
    if (result.error) throw result.error;
    return new TranspiledGame(result);
}

// Same reasoning as isolation.mjs's warnDegraded: silent degradation here looks
// like a scoring bug rather than a platform gap.
function warnSharedRealm(why) {
    try {
        console.warn('[c2js] per-segment realm forking unavailable (' + why + '); '
            + "segments after the first will replay into the previous segment's C globals.");
    } catch {}
}

export { TranspiledGame as NethackGame };
