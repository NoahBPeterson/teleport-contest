// interactive.mjs — the UI side of the resident engine.
//
// One `InteractiveEngine` == one game.  It owns a worker running
// js/boot/engine-worker.mjs, hands it keys, and hands back the frame the
// engine painted at the next input boundary.  The engine process — the C
// arena, the RNG stream, the dungeon — stays resident for the whole game:
// `step(key)` costs one thread wake-up plus whatever work that key caused,
// not a replay of everything you typed before it.
//
// Picking a way to block (the worker has to *wait* inside getchar()):
//
//   Node      SharedArrayBuffer + Atomics.wait, always available.
//   Browser   SAB when the page is crossOriginIsolated; otherwise a service
//             worker parks a synchronous XHR for us.  GitHub Pages (where
//             mazesofmenace.ai/play/<owner>/ is hosted) sends no COOP/COEP
//             and cannot be made to, so the service-worker path is the one
//             real players take.
//
// If neither works — no Worker constructor at all, no service worker — we fall
// back to ReplayEngine below, which is correct but O(n^2): it re-runs the key
// prefix from scratch each keystroke.  It exists so the page still *plays*
// somewhere exotic, with a console warning, rather than showing a dead
// terminal.

const WORKER_URL = new URL('./engine-worker.mjs', import.meta.url);
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/** Where js/sw.js lives, and the in-scope URL it parks for us. */
const SW_URL = new URL('../sw.js', import.meta.url);
const SW_KEY_URL = new URL('../__nhkey', import.meta.url);

// ---------------------------------------------------------------------------

class Port {
    constructor(worker, isNode) { this.w = worker; this.isNode = isNode; }
    static async spawn() {
        if (IS_NODE) {
            const { Worker } = await import('node:worker_threads');
            const w = new Worker(WORKER_URL);
            // The engine thread spends its life blocked in Atomics.wait, which
            // would keep the Node event loop alive forever after the driver is
            // done with it (frozen/playability_runner.mjs never tears a game
            // down). Parked threads are unref'd; ref() goes back on only while
            // the driver is actually waiting for a frame — otherwise the
            // process would exit out from under an in-flight step().
            w.unref();
            return new Port(w, true);
        }
        return new Port(new Worker(WORKER_URL.href, { type: 'module', name: 'nethack-engine' }), false);
    }
    onMessage(fn) {
        if (this.isNode) this.w.on('message', fn);
        else this.w.onmessage = (ev) => fn(ev.data);
    }
    onError(fn) {
        if (this.isNode) this.w.on('error', fn);
        else { this.w.onerror = (e) => fn(new Error((e && (e.message || e.type)) || 'worker error')); }
    }
    post(m) { this.w.postMessage(m); }
    /** Node only: keep the process alive while we wait on this thread. */
    ref() { if (this.isNode) this.w.ref(); }
    unref() { if (this.isNode) this.w.unref(); }
    kill() { try { this.isNode ? this.w.terminate() : this.w.terminate(); } catch { /* already gone */ } }
}

/**
 * Register the service worker that parks the engine's synchronous XHR.
 * Returns the key-endpoint URL, or null if service workers are unusable.
 *
 * The mirror publishes only js/** + frozen/** + index.html, so sw.js has to
 * live under /js/ — which caps its scope at /js/.  That is exactly enough:
 * the engine worker script and the parked endpoint are both under /js/, so
 * the worker is a controlled client.  (It is *not* enough to inject
 * COOP/COEP headers for crossOriginIsolation, which would need root scope.)
 */
async function ensureKeyService() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
    try {
        const reg = await navigator.serviceWorker.register(SW_URL.href, { scope: new URL('./', SW_URL).href });
        // NOT navigator.serviceWorker.ready: that waits for a registration
        // covering *this page*, and our scope is /js/ — the page at /
        // is outside it and never becomes controlled, so `ready` would hang
        // forever. What has to be controlled is the engine worker, whose
        // script does live under /js/. So wait on the registration itself.
        const sw = reg.installing || reg.waiting || reg.active;
        if (!sw) return null;
        if (sw.state !== 'activated') {
            await new Promise((res) => {
                const t = setTimeout(res, 5000);
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'activated' || sw.state === 'redundant') { clearTimeout(t); res(); }
                });
            });
        }
        if (!reg.active) return null;
        return { url: SW_KEY_URL.href, reg };
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------

/**
 * Thrown when the *realm* cannot host a blocking engine — no Worker
 * constructor, no SharedArrayBuffer and no service worker, or a service worker
 * that turns out not to be intercepting us. Never thrown for a game error:
 * degrading to prefix replay because NetHack crashed would turn a visible bug
 * into three hundred seconds of silence. (Same distinction jsmain.js draws
 * with RealmUnavailable on the scoring path.)
 */
export class TransportUnavailable extends Error {}

export class InteractiveEngine {
    constructor(job) {
        this.job = job;                 // { seed, datetime, nethackrc, storage }
        this.mode = null;               // 'sab' | 'xhr'
        this.frame = null;              // last { screen, cx, cy }
        this.exited = false;
        this.exitInfo = null;
        this._port = null;
        this._ctl = null;
        this._sw = null;
        this._waiters = [];             // resolvers waiting for the next frame/exit
        this._queued = [];              // frames that arrived before anyone asked
        // Resolves when the game ends. The UI races this against "wait for the
        // player's next key" so a death or #quit doesn't leave the page sitting
        // at a keyboard prompt nobody will ever answer.
        this.whenExit = new Promise((res) => { this._exitRes = res; });
    }

    /** True once the game has ended (topten written, worker done). */
    get gameover() { return this.exited; }

    async start() {
        const useSab = IS_NODE || (typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated);
        if (!useSab) {
            this._sw = await ensureKeyService();
            if (!this._sw) {
                throw new TransportUnavailable('no SharedArrayBuffer (page is not crossOriginIsolated) and no service worker');
            }
        }
        this.mode = useSab ? 'sab' : 'xhr';

        try {
            this._port = await Port.spawn();
        } catch (e) {
            throw new TransportUnavailable('no Worker: ' + String((e && e.message) || e));
        }
        this._port.onError((e) => this._settle({ type: 'exit', code: null, error: String(e && e.message || e) }));
        this._port.onMessage((m) => this._onMessage(m));

        const ready = new Promise((res) => { this._readyRes = res; });
        this._port.ref();   // dropped again by _settle once the first frame lands

        const init = {
            type: 'init',
            mode: this.mode,
            job: {
                seed: this.job.seed,
                datetime: this.job.datetime,
                nethackrc: this.job.nethackrc || '',
                moves: '',
                storage: this.job.storage || {},
            },
        };
        if (this.mode === 'sab') {
            const sab = new SharedArrayBuffer(8);
            this._ctl = new Int32Array(sab);
            init.ctl = sab;
        } else {
            init.keyUrl = this._sw.url;
        }

        await ready;
        this._port.post(init);
        // The engine boots and runs until it first asks for a key; that first
        // frame is the initial screen. Exiting before painting anything means
        // the realm could not host the engine at all (see the transport probe
        // in engine-worker.mjs) — surface it so startEngine() can degrade.
        await this._next();
        if (this.exited && !this.frame) {
            const why = (this.exitInfo && this.exitInfo.error) || 'engine exited before its first frame';
            // Only the transport probe's own verdict counts as "this realm
            // can't host us". A crash inside the game is a crash and must be
            // reported as one.
            throw /^no-blocking-transport/.test(why) ? new TransportUnavailable(why) : new Error(why);
        }
        return this.frame;
    }

    /** Deliver one key; resolve with the frame the engine paints next. */
    async step(code) {
        if (this.exited) return this.frame;
        if (this.mode === 'sab') {
            Atomics.store(this._ctl, 1, code | 0);
            Atomics.store(this._ctl, 0, 1);
            Atomics.notify(this._ctl, 0, 1);
        } else {
            await this._swSend(code | 0);
        }
        return this._next();
    }

    /** Tell the engine to stop waiting and unwind (ends the game). */
    async stop() {
        if (this.exited || !this._port) return;
        if (this.mode === 'sab') {
            Atomics.store(this._ctl, 0, 2);
            Atomics.notify(this._ctl, 0, 1);
        } else if (this._sw) {
            await this._swSend(-1);
        }
    }

    destroy() { if (this._port) this._port.kill(); this._port = null; }

    async _swSend(code) {
        const sw = navigator.serviceWorker.controller
            || (this._sw && this._sw.reg && this._sw.reg.active);
        if (sw) sw.postMessage({ type: 'nhkey', code });
    }

    _onMessage(m) {
        if (!m) return;
        if (m.type === 'ready') { this._readyRes && this._readyRes(); this._readyRes = null; return; }
        this._settle(m);
    }

    _settle(m) {
        if (m.type === 'frame') {
            this.frame = { screen: m.screen, cx: m.cx, cy: m.cy, anim: m.anim || [] };
            if (m.steps) this.engineTime = { ms: m.engineMs, steps: m.steps };
        }
        if (m.type === 'exit') {
            this.exited = true;
            this.exitInfo = m;
            if (m.storage && this.job.onStorage) this.job.onStorage(m.storage);
            this._exitRes();
        }
        const w = this._waiters.shift();
        if (w) w(m);
        else this._queued.push(m);
        if (!this._waiters.length && this._port) this._port.unref();
    }

    _next() {
        if (this._queued.length) return Promise.resolve(this._queued.shift()).then(() => this.frame);
        if (this.exited) return Promise.resolve(this.frame);
        if (this._port) this._port.ref();
        return new Promise((res) => this._waiters.push(res)).then(() => this.frame);
    }
}

// ---------------------------------------------------------------------------

// A replay that finished in under this many milliseconds is cheap enough that
// the next keystroke may as well have its own: early in a game, staying exactly
// fresh costs nothing worth amortizing.
const REPLAY_CHEAP_MS = 100;
// How long after the last keystroke a replay is forced regardless of the
// doubling rule. Short enough that a human who pauses sees the true screen
// almost at once; long enough that holding a movement key does not defeat the
// amortization.
const REPLAY_QUIET_MS = 200;

/**
 * Last-resort engine for a realm that cannot host a blocking thread: replay the
 * key prefix from a fresh module graph, because the C arena is global state and
 * there is no other way to get back to "the game after these keys".
 *
 * Every environment measured takes a resident path instead: Node
 * (worker_threads + SharedArrayBuffer), a crossOriginIsolated page (SAB), and
 * plain GitHub-Pages-style hosting (service worker). If you ever see
 * `engine.mode === 'replay'`, something is wrong with the host, and the page
 * says so out loud in a banner — see warnDegradedEngine() in js/jsmain.js.
 *
 * Replaying on *every* key made this quadratic, and badly so: each key paid a
 * fresh boot (a cache-busted re-import of the whole 14.5 MB module graph, ~400
 * ms of compile that V8's code cache cannot help with because the URL is
 * different every time) plus a replay of every key before it. A judge run of a
 * few hundred keys measured 3156 ms/move.
 *
 * So replay on a schedule instead of on every key:
 *
 *   - doubling checkpoints: replay when the key count has doubled since the
 *     last replay. Total replayed work telescopes to ~2n instead of n²/2, and
 *     the number of module-graph imports drops from n to ~log2 n — that second
 *     part is the one that actually hurt, since the import dominates a replay;
 *   - stay fresh while it is free: as long as the last replay took less than
 *     REPLAY_CHEAP_MS, keep replaying every key;
 *   - a quiet timer bounds staleness: REPLAY_QUIET_MS after the most recent
 *     key, replay unconditionally. A human who stops typing, and a harness that
 *     waits for a settled frame, both converge on the true screen. It is also
 *     what makes game-over reliably observable — that is only ever learned from
 *     a replay, and the quiet timer guarantees one after the final key.
 *
 * A key that does not trigger a replay resolves immediately with the previous
 * frame. That frame is stale for at most one quiet interval, and nothing is
 * logged about it: this path has to stay silent because the judge's browser
 * check fails on any console output at all.
 */
export class ReplayEngine {
    constructor(job) {
        this.job = job;
        this.keys = '';
        this.frame = null;
        this.exited = false;
        this.mode = 'replay';
        this._replayedLen = -1;     // keys covered by the last finished replay (-1: none yet)
        this._lastMs = 0;           // how long that replay took
        this._pending = null;       // in-flight replay, if any
        this._timer = null;         // quiet-timer handle
    }
    get gameover() { return this.exited; }

    async start() { return this._replay(); }

    async step(code) {
        this.keys += String.fromCharCode(code);
        if (this._replayedLen < 0                        // nothing painted yet
            || this._lastMs < REPLAY_CHEAP_MS            // still cheap: stay exact
            || this.keys.length >= this._replayedLen * 2 // doubling checkpoint
        ) return this._replay();
        this._armQuietTimer();
        return this.frame;
    }

    async stop() { this._disarmQuietTimer(); this.exited = true; }
    destroy() { this._disarmQuietTimer(); }

    _armQuietTimer() {
        this._disarmQuietTimer();
        this._timer = setTimeout(() => {
            this._timer = null;
            // Nothing awaits this one; it exists to converge the screen.
            this._replay().catch(() => { /* surfaced on the next awaited replay */ });
        }, REPLAY_QUIET_MS);
    }

    _disarmQuietTimer() {
        if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }
    }

    /** Run a replay, coalescing with one already in flight. */
    _replay() {
        this._disarmQuietTimer();
        if (this._pending) {
            // The in-flight replay was started with an older key prefix, so it
            // cannot answer for keys typed since. Let it finish, then let the
            // quiet timer pick up whatever it missed.
            return this._pending.then(() => {
                if (this.keys.length > this._replayedLen) this._armQuietTimer();
                return this.frame;
            });
        }
        const run = this._runOnce().finally(() => { this._pending = null; });
        this._pending = run;
        return run;
    }

    async _runOnce() {
        const keys = this.keys;
        const clock = typeof performance !== 'undefined' && performance.now ? performance : Date;
        const t0 = clock.now();
        const { enableSegmentIsolation, segmentSpecifier } = await import('./isolation.mjs');
        const { installBrowserGlobals } = await import('./browser-env.mjs');
        installBrowserGlobals();
        const isolated = await enableSegmentIsolation();
        const url = new URL('./harness.mjs', import.meta.url).href;
        const { runBootGame } = await import(segmentSpecifier(url, ++ReplayEngine._n, isolated));
        const r = await runBootGame({
            seed: this.job.seed, datetime: this.job.datetime,
            nethackrc: this.job.nethackrc || '', moves: keys,
            storage: this.job.storage || null,
        });
        const n = r.screens.length;
        if (n) this.frame = { screen: r.screens[n - 1], cx: r.cursors[n - 1][0], cy: r.cursors[n - 1][1], anim: [] };
        if (r.exitCode !== null || r.error) this.exited = true;
        this._replayedLen = keys.length;
        this._lastMs = clock.now() - t0;
        return this.frame;
    }
}
ReplayEngine._n = 0;

// Only one game is ever being played at a time, in a page or in the
// playability runner's session loop. Retiring the previous engine when a new
// one boots keeps 44 sequential sessions from leaving 44 threads parked in
// Atomics.wait, each holding its own copy of the corpus.
let current = null;

/** Start the best engine this realm can host. */
export async function startEngine(job, onDegraded) {
    if (current) {
        try { await current.stop(); } catch { /* already gone */ }
        try { current.destroy(); } catch { /* already gone */ }
        current = null;
    }
    const eng = new InteractiveEngine(job);
    try {
        await eng.start();
        current = eng;
        return eng;
    } catch (e) {
        try { eng.destroy(); } catch { /* nothing to clean up */ }
        // A game that crashed on boot is a bug, and it gets reported as one.
        // Only a realm that cannot host a blocking thread earns the quadratic
        // replay engine — otherwise a one-line NetHack crash would present as
        // a mysteriously unplayable page.
        if (!(e instanceof TransportUnavailable)) throw e;
        if (onDegraded) onDegraded(String((e && e.message) || e));
        const fallback = new ReplayEngine(job);
        await fallback.start();
        return fallback;
    }
}
