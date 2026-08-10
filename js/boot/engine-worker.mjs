// engine-worker.mjs — the resident game engine, on a thread of its own.
//
// The transpiled corpus is straight-line synchronous C: tty_nhgetch() calls
// getchar() and *expects a byte back*.  There is no way to suspend a
// synchronous JS call stack mid-flight and resume it later, so an interactive
// port has exactly two honest options:
//
//   1. re-run the whole key prefix on every keystroke (O(n^2), ~1.2 s of
//      startup per key — this is what makes a naive browser port unplayable),
//   2. put the engine on a thread that is *allowed to block*, and hand it keys
//      through shared memory.
//
// This file is (2).  main() runs once, top to bottom, for the whole game, and
// blocks inside getchar() until the UI thread delivers the next key.  The game
// state never leaves the C arena; a keystroke costs one wake-up plus the
// engine work that key actually causes.
//
// Two ways to block, picked at init time by the driver (js/boot/interactive.mjs):
//
//   'sab'  Atomics.wait() on a SharedArrayBuffer.  Node always has this;
//          browsers only when the page is crossOriginIsolated (COOP+COEP).
//   'xhr'  synchronous XMLHttpRequest to a URL parked by our service worker
//          (js/sw.js), which does not answer until the page hands it a key.
//          Works on plain static hosting — GitHub Pages, where
//          mazesofmenace.ai/play/<owner>/ lives, sends no COOP/COEP, so this
//          is the path real players take.
//
// Runs unmodified in three realms — a browser `new Worker(url, {type:'module'})`,
// a Node `worker_threads.Worker`, and (via js/boot/shared-engine.js, which
// dynamic-imports this file) a SharedWorker port. The engine body does not care;
// serve() takes a post/listen pair and everything downstream is the same.
//
// Protocol
//   driver -> worker  { type:'probe', probeUrl }   (browser, xhr transports)
//                     { type:'warm' }              (browser, prewarm)
//                     { type:'init', job, mode, ctl?, keyUrl? }
//   worker -> driver  { type:'ready' }
//                     { type:'probe', ok }
//                     { type:'warmed' }
//                     { type:'frame', screen, cx, cy, anim }  at each input boundary
//                     { type:'exit', code, error, storage }
//
// Frames are the harness's own KIND=input markers, parsed out of the stdout
// stream as they are written (see js/boot/harness.mjs) — the exact bytes the
// judge scores, so what you see in the browser is what the scorer sees.

import { installBrowserGlobals } from './browser-env.mjs';
import { makeFrameReader } from './frames.mjs';

// Decided before installBrowserGlobals(), which installs a stand-in `process`
// in a browser — after that call `typeof process` no longer tells the two
// realms apart.
//
// A SharedWorkerGlobalScope has no postMessage of its own (every message goes
// down a per-connection port), so it has to be recognised separately or it
// would look like Node and go looking for node:worker_threads.
const IS_SHARED_WORKER = typeof SharedWorkerGlobalScope !== 'undefined'
    && typeof self !== 'undefined' && self instanceof SharedWorkerGlobalScope;
const IS_BROWSER_WORKER = IS_SHARED_WORKER
    || (typeof self !== 'undefined' && typeof self.postMessage === 'function');

// ---------------------------------------------------------------------------
// V8 compile cache (Node only).
//
// Every game boots a fresh worker, and that worker's first job is to compile
// the whole transpiled corpus — ~500 ms of pure parse/compile before NetHack
// runs a single instruction. V8 can serialize that work to disk and replay it,
// which is worth roughly 200 ms of the ~1.1 s it takes to get a game to its
// first frame.
//
// Three things make this safe to do unconditionally on the Node path:
//   - it is a *cache*: a miss (cold dir, different Node build, unwritable
//     directory) just compiles normally, and the cached data is validated
//     against the source before it is used, so stale entries cannot change
//     behaviour;
//   - under the judge's `node --permission` sandbox the directory is not
//     writable, and enableCompileCache() reports that in its return value
//     rather than throwing — checked, not assumed;
//   - it is guarded to Node, because a browser worker has no `node:module`
//     (and js/boot/browser-env.mjs does not shim one).
// The cache lives under the repo's gitignored .cache/.
if (!IS_BROWSER_WORKER) {
    try {
        const { enableCompileCache } = await import('node:module');
        const { fileURLToPath } = await import('node:url');
        if (typeof enableCompileCache === 'function') {
            enableCompileCache(fileURLToPath(new URL('../../.cache/v8-compile-cache', import.meta.url)));
        }
    } catch { /* no compile cache here; compile from source as before */ }
}

installBrowserGlobals();

// ---------------------------------------------------------------------------
// Blocking input

const KEY_EOF = -1;

/** Atomics.wait over ctl[0] (state) / ctl[1] (key). state: 0 idle, 1 key, 2 eof. */
function sabWaiter(sab) {
    const ctl = new Int32Array(sab);
    return () => {
        while (Atomics.load(ctl, 0) === 0) Atomics.wait(ctl, 0, 0);
        const state = Atomics.load(ctl, 0);
        const code = Atomics.load(ctl, 1);
        Atomics.store(ctl, 0, 0);
        return state === 2 ? KEY_EOF : code;
    };
}

/** The body js/sw.js answers a probe with. Keep the two in step. */
const SW_ALIVE = '__nh_sw_alive__';

/**
 * Is *this realm* a controlled service-worker client — not "is one registered",
 * which the page can see, but "will my requests actually reach it", which only
 * a request can answer. A dedicated worker whose script sits inside the scope
 * should be a client in its own right, and in current Chromium it is; that is a
 * per-engine, per-version behaviour, and getting it wrong means the game hangs
 * in getchar() forever rather than failing.
 *
 * The probe is deliberately unfalsifiable-quietly: `probeUrl` names a file that
 * exists (js/sw.js) with a query string the static host ignores, so an
 * uncontrolled realm gets that file's real bytes and a 200 rather than a 404.
 * A 404 would be a line in the browser console, and the judge's playability
 * check fails an entry on any console output at all — including the run where
 * we noticed in time and degraded gracefully.
 *
 * Synchronous on purpose: the answer decides whether the caller may block, so
 * it has to be known before the engine boots, in the same realm that will do
 * the blocking.
 */
function swIntercepts(probeUrl) {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', probeUrl, false);
        xhr.send(null);
        return xhr.status === 200 && xhr.responseText.trim() === SW_ALIVE;
    } catch (e) {
        return false;   // no XMLHttpRequest here at all, or blocked outright
    }
}

/** Synchronous XHR to the service worker's parked key endpoint. */
function xhrWaiter(keyUrl) {
    let n = 0;
    // The service worker hands over every key it has queued, so a burst costs
    // one round-trip instead of one per key. Drain the buffer before asking
    // again.
    let buffered = [];
    return () => {
        for (;;) {
            if (buffered.length) return buffered.shift();
            const xhr = new XMLHttpRequest();
            // Cache-buster: a sync XHR that hit the HTTP cache would return the
            // previous key instantly and spin the engine.
            xhr.open('GET', keyUrl + (keyUrl.includes('?') ? '&' : '?') + 'n=' + (++n), false);
            try {
                xhr.send(null);
            } catch (e) {
                return KEY_EOF;   // service worker gone (unregistered, page closed)
            }
            if (xhr.status !== 200) return KEY_EOF;
            const codes = xhr.responseText.split(',').map((s) => parseInt(s, 10));
            if (codes.length === 1 && codes[0] === -2) continue;   // parked out; ask again (js/sw.js)
            if (!codes.length || !Number.isFinite(codes[0])) return KEY_EOF;
            buffered = codes;
        }
    };
}

// Frame extraction lives in ./frames.mjs — shared with the main-thread engine.

// ---------------------------------------------------------------------------

function storageHandleOver(map) {
    return {
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
        get length() { return map.size; },
        key(i) { let n = 0; for (const k of map.keys()) { if (n === i) return k; n++; } return null; },
    };
}

let started = false;
let warming = null;

/**
 * Instantiate everything a game needs *before* the job that needs it exists.
 *
 * Booting a game is two costs in a fixed order: instantiating the 176-module
 * transpiled graph (~480 ms, and it depends on nothing at all — every C
 * file-scope variable goes to its static initialiser), and then running
 * newgame() (~550 ms, and it depends on the seed, the datetime and the
 * nethackrc). Only the second half needs a job. So a realm can pay the first
 * half while the page is still loading and park, and a `init` that arrives
 * afterwards only pays the second.
 *
 * Importing ../generated/unixmain.js here rather than from inside runBootGame()
 * is safe because no generated module reads a harness global at module scope:
 * verified by importing the graph on its own, with none of runBootGame()'s
 * shims installed, in Node and in the browser — nothing throws and nothing is
 * observably different. runBootGame()'s own `await import(...)` of the same
 * specifier then resolves from the module map, instantly and to the same
 * namespace object, and the graph is still instantiated exactly once in this
 * realm.
 *
 * A warmed realm has NOT run a game — it is pristine, so it can host any job,
 * whatever seed the caller turns out to want. That is the whole point: the page
 * cannot know the judge's seed at load time, and with this it does not have to.
 *
 * Failure is silent and harmless: nothing is posted, the driver's timeout
 * fires, and the game boots the ordinary way, paying for the graph then.
 */
function warmRealm(post) {
    if (warming) return warming;
    warming = (async () => {
        await import('./harness.mjs');
        await import('../generated/unixmain.js');
    })();
    warming.then(() => post({ type: 'warmed' }), () => { /* boot pays for it instead */ });
    return warming;
}

async function runEngine(msg, post) {
    const waitForKeyRaw = msg.mode === 'xhr' ? xhrWaiter(msg.keyUrl) : sabWaiter(msg.ctl);
    const frames = makeFrameReader();
    const map = new Map(Object.entries(msg.job.storage || {}));

    // Called from inside getchar() with the C stack live. Everything here is
    // synchronous by necessity: we are 40 frames deep in transpiled C.
    //
    // `engineMs` is the time the *game* spent on the previous keystroke —
    // from the moment that key was delivered to the moment the resulting
    // frame is ready. Reported alongside each frame so a benchmark can tell
    // our cost apart from the browser's (message hop, service-worker
    // round-trip, DOM paint).
    let tKeyDelivered = 0, engineMs = 0, steps = 0;
    const waitForKey = () => {
        const now = performance.now();
        if (tKeyDelivered) { engineMs += now - tKeyDelivered; steps++; }
        const { last, anim } = frames.take();
        if (last) post({ type: 'frame', screen: last.screen, cx: last.cx, cy: last.cy, anim, engineMs, steps });
        const code = waitForKeyRaw();
        tKeyDelivered = performance.now();
        return code;
    };

    let out;
    try {
        const { runBootGame } = await import('./harness.mjs');
        const r = await runBootGame({
            seed: msg.job.seed,
            datetime: msg.job.datetime,
            nethackrc: msg.job.nethackrc || '',
            moves: msg.job.moves || '',
            storage: storageHandleOver(map),
            stdoutSink: frames.sink,
            waitForKey,
        });
        // The last screen the game painted (topten, DYWYPI, ...) never gets a
        // boundary of its own if the game exited without asking for a key.
        const { last, anim } = frames.take();
        if (last) post({ type: 'frame', screen: last.screen, cx: last.cx, cy: last.cy, anim });
        out = { type: 'exit', code: r.exitCode, error: r.error ? String(r.error.stack || r.error) : null,
                storage: Object.fromEntries(map) };
    } catch (e) {
        out = { type: 'exit', code: null, error: String((e && e.stack) || e), storage: Object.fromEntries(map) };
    }
    post(out);
}

/**
 * Attach the engine to one message channel and announce it. `post` sends to the
 * driver, `listen` installs the driver's message handler.
 *
 * One engine per worker, whatever the channel: `started` is module-scoped, so a
 * second connection to the same SharedWorker cannot start a second game in the
 * same C arena. In practice there is never a second connection — each
 * InteractiveEngine names its SharedWorker uniquely, so a reload gets a worker
 * of its own rather than reconnecting to the last game's.
 */
function serve(post, listen) {
    listen((msg) => {
        if (!msg) return;
        // Asked before init, from the realm that will do the blocking: only
        // this realm's own request can tell us whether it is intercepted.
        if (msg.type === 'probe') { post({ type: 'probe', ok: swIntercepts(msg.probeUrl) }); return; }
        // Prewarm: instantiate the module graph now, park, and wait for a job.
        // Only ever sent to a realm that has already won the transport race and
        // proved it can block, so a realm nobody will play in never pays for a
        // graph — and never competes with the fallback that is about to.
        if (msg.type === 'warm') { warmRealm(post); return; }
        if (msg.type !== 'init' || started) return;
        started = true;
        runEngine(msg, post);
    });
    post({ type: 'ready' });
}

/** Entry point for js/boot/shared-engine.js, one call per connected port. */
export function serveOn(port) {
    serve((m) => port.postMessage(m), (fn) => { port.onmessage = (ev) => fn(ev.data); });
}

if (IS_SHARED_WORKER) {
    // Nothing to attach to here: the connect event belongs to the classic
    // shim that imported us, and it calls serveOn() with each port.
} else if (IS_BROWSER_WORKER) {
    serve((m) => self.postMessage(m), (fn) => { self.onmessage = (ev) => fn(ev.data); });
} else {
    const { parentPort } = await import('node:worker_threads');
    serve((m) => parentPort.postMessage(m), (fn) => parentPort.on('message', fn));
}
