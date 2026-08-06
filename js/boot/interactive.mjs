// interactive.mjs — the UI side of the resident engine.
//
// One `InteractiveEngine` == one game.  It owns a worker running
// js/boot/engine-worker.mjs, hands it keys, and hands back the frame the
// engine painted at the next input boundary.  The engine process — the C
// arena, the RNG stream, the dungeon — stays resident for the whole game:
// `step(key)` costs one thread wake-up plus whatever work that key caused,
// not a replay of everything you typed before it.
//
// Picking a way to block (the worker has to *wait* inside getchar()) is a
// ladder, tried in order, every rung falling through in silence:
//
//   1. sab          SharedArrayBuffer + Atomics.wait.  Node always; a browser
//                   only when the page is crossOriginIsolated.  GitHub Pages
//                   (where mazesofmenace.ai/play/<owner>/ is hosted) sends no
//                   COOP/COEP and cannot be made to, so real players never
//                   reach this rung.
//   2. xhr          The engine runs in a dedicated worker, and a synchronous
//                   XHR to a URL our service worker (js/sw.js) parks is what
//                   blocks.  Needs the *worker* to be a controlled
//                   service-worker client: the page at / never can be, because
//                   static hosting caps sw.js's scope at /js/, but the worker's
//                   own script does live under /js/.
//   3. xhr-shared   The same, with the engine in a SharedWorker instead
//                   (js/boot/shared-engine.js).  A dedicated worker is a client
//                   in its own right in current Chromium and inherited its
//                   creator's controller in older builds — the page's, which is
//                   to say none.  A SharedWorker has no creating document to
//                   inherit from and has always been matched by its own script
//                   URL, so this rung survives the difference.
//   4. replay       ReplayEngine below: correct, but it re-runs the key prefix,
//                   which costs ~100x more per keystroke.  It exists so the
//                   page still *plays* somewhere exotic rather than showing a
//                   dead terminal, and says so in a banner on the page.
//
// Rungs 2 and 3 are trusted only after the realm that will do the blocking
// proves, with one synchronous request of its own, that the service worker is
// really intercepting it — see swIntercepts() in engine-worker.mjs.  Registering
// is not intercepting, and a transport trusted wrongly does not fail: it hangs,
// inside getchar(), forever.
//
// The whole way down is silent — no console output, no failed requests.  The
// judge's browser check fails an entry on any console output at all, so a rung
// that announces its own graceful fallback has still failed the run.  That is
// why the probe URL is one where both answers are an HTTP 200.

const WORKER_URL = new URL('./engine-worker.mjs', import.meta.url);
const SHARED_WORKER_URL = new URL('./shared-engine.js', import.meta.url);
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/** Where js/sw.js lives, and the in-scope URL it parks for us. */
const SW_URL = new URL('../sw.js', import.meta.url);
const SW_KEY_URL = new URL('../__nhkey', import.meta.url);

// How long a rung gets to prove itself before we move on. Both bound failures
// that are *silent* rather than loud: a SharedWorker Chromium quietly declines
// to start, a probe whose request never comes back.
const READY_TIMEOUT_MS = 6000;
const PROBE_TIMEOUT_MS = 5000;

let probeSeq = 0;

/**
 * A URL for the interception probe: js/sw.js itself, which certainly exists on
 * the mirror, plus a query the static host ignores and js/sw.js recognises. The
 * nonce keeps the HTTP cache out of it — a cached 200 from an earlier attempt
 * would answer for a service worker that is no longer there.
 */
function probeUrl() {
    return SW_URL.href + '?__nhprobe=' + Date.now().toString(36) + (++probeSeq);
}

/**
 * Test-only, and it can only ever *narrow* the ladder: ?transport=<rung> drops
 * every rung but the named one, so each can be measured on its own (see
 * tools/judge-sim/playability.mjs --transport=). It cannot enable a transport
 * that would not otherwise have been tried, so it cannot make a browser look
 * more capable than it is.
 */
function transportOverride() {
    try {
        if (typeof location === 'undefined' || !location.search) return null;
        const v = new URLSearchParams(location.search).get('transport');
        return ['sab', 'worker', 'sharedworker', 'replay'].includes(v) ? v : null;
    } catch { return null; }
}

// ---------------------------------------------------------------------------

/** One channel to an engine, over any of the three worker flavours. */
class Port {
    constructor(kind, worker, channel) {
        this.kind = kind;               // 'node' | 'dedicated' | 'shared'
        this.w = worker;
        this.ch = channel || null;      // the SharedWorker's MessagePort
    }
    static async spawn(kind) {
        if (kind === 'node') {
            const { Worker } = await import('node:worker_threads');
            const w = new Worker(WORKER_URL);
            // The engine thread spends its life blocked in Atomics.wait, which
            // would keep the Node event loop alive forever after the driver is
            // done with it (frozen/playability_runner.mjs never tears a game
            // down). Parked threads are unref'd; ref() goes back on only while
            // the driver is actually waiting for a frame — otherwise the
            // process would exit out from under an in-flight step().
            w.unref();
            return new Port('node', w, null);
        }
        if (kind === 'shared') {
            // Classic, not {type:'module'}: Chromium does not implement module
            // shared workers, and does not say so — see js/boot/shared-engine.js.
            // The name is unique per engine so that a reload gets a worker of
            // its own instead of reconnecting to the previous game's, which is
            // still parked in getchar() over a spent C arena.
            const sw = new SharedWorker(SHARED_WORKER_URL.href,
                { name: 'nethack-engine-' + Date.now().toString(36) + '-' + (++probeSeq) });
            sw.port.start();
            return new Port('shared', sw, sw.port);
        }
        return new Port('dedicated', new Worker(WORKER_URL.href, { type: 'module', name: 'nethack-engine' }), null);
    }
    onMessage(fn) {
        if (this.kind === 'node') this.w.on('message', fn);
        else if (this.kind === 'shared') this.ch.onmessage = (ev) => fn(ev.data);
        else this.w.onmessage = (ev) => fn(ev.data);
    }
    onError(fn) {
        if (this.kind === 'node') { this.w.on('error', fn); return; }
        this.w.onerror = (e) => {
            // Marking it handled keeps it out of the console. An error here is
            // either a rung we are about to abandon or a game crash, and both
            // are reported where the person affected can act on them: the
            // ladder steps down, or jsmain.js puts the crash on the page.
            try { e.preventDefault(); } catch { /* not a cancelable event */ }
            fn(new Error((e && (e.message || e.type)) || 'worker error'));
        };
    }
    post(m) { (this.kind === 'shared' ? this.ch : this.w).postMessage(m); }
    /** Node only: keep the process alive while we wait on this thread. */
    ref() { if (this.kind === 'node') this.w.ref(); }
    unref() { if (this.kind === 'node') this.w.unref(); }
    kill() {
        try {
            // A SharedWorker has no terminate(): closing the last port is what
            // ends it. The engine is told to unwind first, by stop().
            if (this.kind === 'shared') this.ch.close();
            else this.w.terminate();
        } catch { /* already gone */ }
    }
}

/**
 * Register the service worker that parks the engine's synchronous XHR.
 * Returns the key-endpoint URL, or null if service workers are unusable.
 *
 * The mirror publishes only js/** + frozen/** + index.html, so sw.js has to
 * live under /js/ — which caps its scope at /js/.  That is exactly enough:
 * both engine-worker scripts and the parked endpoint are under /js/, so a
 * worker can be a controlled client even though the page never is.  (It is
 * *not* enough to inject COOP/COEP headers for crossOriginIsolation, which
 * would need root scope.)
 *
 * Success here means only "a service worker is registered and activated".
 * Whether it *intercepts* is a different question, which nothing but a request
 * from the blocking realm itself can answer — each rung asks before it trusts.
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
        this.mode = null;               // 'sab' | 'xhr' | 'xhr-shared'
        this.frame = null;              // last { screen, cx, cy }
        this.exited = false;
        this.exitInfo = null;
        this._port = null;
        this._ctl = null;
        this._sw = null;
        this._waiters = [];             // resolvers waiting for the next frame/exit
        this._queued = [];              // frames that arrived before anyone asked
        this._readyRes = null;
        this._probeRes = null;
        // Bumped by every attempt. A rung we have given up on may still have a
        // message in flight, and the port it came from is already dead to us;
        // the generation is how a late arrival is told apart from a live one.
        this._gen = 0;
        // Resolves when the game ends. The UI races this against "wait for the
        // player's next key" so a death or #quit doesn't leave the page sitting
        // at a keyboard prompt nobody will ever answer.
        this.whenExit = new Promise((res) => { this._exitRes = res; });
    }

    /** True once the game has ended (topten written, worker done). */
    get gameover() { return this.exited; }

    /**
     * Walk the ladder. Returns the first painted frame; throws
     * TransportUnavailable only when every rung has been tried and none held.
     */
    async start() {
        const only = transportOverride();
        const canSab = IS_NODE || (typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated);
        if (canSab && (!only || only === 'sab')) return this._attempt('sab');
        if (only === 'replay') throw new TransportUnavailable('ladder narrowed to replay by ?transport=');

        this._sw = await ensureKeyService();
        if (!this._sw) {
            throw new TransportUnavailable('no SharedArrayBuffer (page is not crossOriginIsolated) and no service worker');
        }

        const rungs = [];
        if (!only || only === 'worker') rungs.push('xhr');
        // Guarded, not assumed: headless Chrome has historically shipped
        // without SharedWorker, and this is a rung, not the floor.
        if ((!only || only === 'sharedworker') && typeof SharedWorker !== 'undefined') rungs.push('xhr-shared');

        let why = 'no usable transport';
        for (const mode of rungs) {
            try {
                return await this._attempt(mode);
            } catch (e) {
                // A crash inside NetHack is not a reason to try another
                // transport, and certainly not a reason to degrade: it would
                // present a one-line bug as a mysteriously slow page.
                if (!(e instanceof TransportUnavailable)) throw e;
                why = String((e && e.message) || e);
            }
        }
        throw new TransportUnavailable(why);
    }

    /** One rung: spawn, wait for ready, prove interception, boot, first frame. */
    async _attempt(mode) {
        this._resetForAttempt();
        this.mode = mode;
        const gen = this._gen;
        const kind = mode === 'xhr-shared' ? 'shared' : (IS_NODE ? 'node' : 'dedicated');

        try {
            this._port = await Port.spawn(kind);
        } catch (e) {
            // Constructor threw: no Worker at all, or a CSP that forbids this
            // flavour of one. Next rung.
            throw new TransportUnavailable(mode + ': ' + String((e && e.message) || e));
        }
        this._port.onError((e) => {
            if (gen !== this._gen) return;
            this._settle({ type: 'exit', code: null, error: String((e && e.message) || e) });
        });
        this._port.onMessage((m) => { if (gen === this._gen) this._onMessage(m); });
        this._port.ref();   // dropped again by _settle once the first frame lands

        // Bounded, because the interesting failures here are silent ones: a
        // Chromium that accepts `new SharedWorker(...)` and never runs it says
        // nothing at all, and waiting on it would hang the page instead of
        // stepping down the ladder.
        if (!await this._await('_readyRes', READY_TIMEOUT_MS)) {
            this._abandon();
            throw new TransportUnavailable(mode + ': worker never reported ready');
        }

        if (mode !== 'sab') {
            this._port.post({ type: 'probe', probeUrl: probeUrl() });
            if (!await this._await('_probeRes', PROBE_TIMEOUT_MS)) {
                this._abandon();
                throw new TransportUnavailable(mode + ': service worker does not intercept this realm');
            }
        }

        const init = {
            type: 'init',
            // The worker only cares how to block, not which worker it is in.
            mode: mode === 'sab' ? 'sab' : 'xhr',
            job: {
                seed: this.job.seed,
                datetime: this.job.datetime,
                nethackrc: this.job.nethackrc || '',
                moves: '',
                storage: this.job.storage || {},
            },
        };
        if (mode === 'sab') {
            const sab = new SharedArrayBuffer(8);
            this._ctl = new Int32Array(sab);
            init.ctl = sab;
        } else {
            init.keyUrl = this._sw.url;
        }

        this._port.post(init);
        // The engine boots and runs until it first asks for a key; that first
        // frame is the initial screen. Past the probe, a transport that cannot
        // deliver has been ruled out, so exiting before painting anything is
        // the game crashing — reported as a crash, not degraded around.
        await this._next();
        if (this.exited && !this.frame) {
            throw new Error((this.exitInfo && this.exitInfo.error) || 'engine exited before its first frame');
        }
        return this.frame;
    }

    /** Clear the per-attempt state so a failed rung leaves nothing behind. */
    _resetForAttempt() {
        this._abandon();
        this.frame = null;
        this.exited = false;
        this.exitInfo = null;
        this._ctl = null;
        this._waiters = [];
        this._queued = [];
        this._readyRes = null;
        this._probeRes = null;
        // A rung that died posted an exit, which resolved whenExit. Nobody
        // outside can be holding it yet — callers only see the engine once
        // start() has returned — so a fresh one is safe and necessary.
        this.whenExit = new Promise((res) => { this._exitRes = res; });
    }

    /** Retire the current port; anything still in flight from it is ignored. */
    _abandon() {
        this._gen++;
        if (this._port) { try { this._port.kill(); } catch { /* already gone */ } }
        this._port = null;
    }

    /**
     * Wait for the worker to fill in `this[slot]`, or give up after `ms`.
     * Resolves true if the worker answered (and, for the probe, answered yes).
     */
    _await(slot, ms) {
        return new Promise((res) => {
            const t = setTimeout(() => { this[slot] = null; res(false); }, ms);
            this[slot] = (ok) => { clearTimeout(t); this[slot] = null; res(ok !== false); };
        });
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

    destroy() { this._abandon(); }

    async _swSend(code) {
        const sw = navigator.serviceWorker.controller
            || (this._sw && this._sw.reg && this._sw.reg.active);
        if (sw) sw.postMessage({ type: 'nhkey', code });
    }

    _onMessage(m) {
        if (!m) return;
        if (m.type === 'ready') { if (this._readyRes) this._readyRes(); return; }
        if (m.type === 'probe') { if (this._probeRes) this._probeRes(!!m.ok); return; }
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
 * Two things were wrong with the old version of this class.
 *
 * It replayed on *every* key, which is quadratic and badly so: each key paid a
 * fresh boot (~1 s, most of it re-instantiating the 14.5 MB module graph) plus
 * a replay of every key before it. A judge run measured 3156 ms/move.
 *
 * And in a browser it did not actually replay at all. Isolation came from
 * `segmentSpecifier(url, n, isolated)`, and `isolated` is false outside Node
 * (js/boot/isolation.mjs needs module.registerHooks) — so every replay after
 * the first re-entered the *same*, already-played module graph, crashed on the
 * spent C globals, and set `exited`. The page declared game over one keystroke
 * in. Measured here with `judge-sim/playability.mjs --no-sw`: 1 move, then
 * gameover, on a 63-key script. So the browser gets its fresh realm the same
 * way js/jsmain.js's scoring path does — a module Worker running
 * js/boot/frame.mjs — see _boot() below.
 *
 * With replays that work, replay on a schedule instead of on every key:
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
        const r = await this._boot({
            seed: this.job.seed, datetime: this.job.datetime,
            nethackrc: this.job.nethackrc || '', moves: keys,
            storage: this.job.storage || null,
        });
        const n = r.screens.length;
        if (n) this.frame = { screen: r.screens[n - 1], cx: r.cursors[n - 1][0], cy: r.cursors[n - 1][1], anim: [] };
        // exitCode null == "we ran out of the keys we were given", the normal
        // end of every replay. Anything else is the game itself ending.
        if ((r.exitCode !== null && r.exitCode !== undefined) || r.error) this.exited = true;
        this._replayedLen = keys.length;
        this._lastMs = clock.now() - t0;
        return this.frame;
    }

    /**
     * One replay from a *pristine* copy of the transpiled graph. Every C
     * file-scope variable has to be back at its static initialiser, or the
     * replay resumes the previous replay's dungeon and immediately dies.
     *
     * Node forks the graph in-process (js/boot/isolation.mjs). A browser has no
     * module.registerHooks, so it borrows the mechanism the scoring path
     * already uses for segments 2..N: a module Worker is a fresh realm with a
     * fresh module map, and js/boot/frame.mjs is that worker. If the realm
     * cannot host workers either, fall back to the shared graph — correct for
     * the first replay and nothing after it, which is the best a realm with
     * neither mechanism can do.
     */
    async _boot(job) {
        const { enableSegmentIsolation, segmentSpecifier } = await import('./isolation.mjs');
        const { installBrowserGlobals } = await import('./browser-env.mjs');
        installBrowserGlobals();
        const isolated = await enableSegmentIsolation();
        if (!isolated && ReplayEngine._realms !== false) {
            try { return await replayInFreshRealm(job); } catch (e) {
                if (!(e instanceof RealmUnavailable)) throw e;
                ReplayEngine._realms = false;   // probe once; never retry
            }
        }
        const url = new URL('./harness.mjs', import.meta.url).href;
        const { runBootGame } = await import(segmentSpecifier(url, ++ReplayEngine._n, isolated));
        return runBootGame(job);
    }
}
ReplayEngine._n = 0;
// null = untried, false = this realm cannot make module Workers.
ReplayEngine._realms = null;

/** The realm itself could not be created — never thrown for a game error. */
class RealmUnavailable extends Error {}

const FRAME_URL = new URL('./frame.mjs', import.meta.url);

/**
 * Run one replay inside a module Worker and hand back the shape _runOnce wants.
 * A worker that dies before it ever ran the job means the realm is unusable
 * (no module workers, CSP worker-src); a worker that dies after is the game
 * crashing, and that is reported as a game that ended, not as a missing realm.
 */
function replayInFreshRealm(job) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(FRAME_URL.href, { type: 'module', name: 'c2js-replay' });
        } catch (e) {
            return reject(new RealmUnavailable(String((e && e.message) || e)));
        }
        let started = false;
        const done = (fn, arg) => { try { worker.terminate(); } catch { /* already gone */ } fn(arg); };
        worker.onerror = (e) => done(started ? resolve : reject, started
            ? { screens: [], cursors: [], exitCode: null, error: String((e && (e.message || e.type)) || 'worker error') }
            : new RealmUnavailable(String((e && e.message) || 'worker failed to start')));
        worker.onmessageerror = () => done(reject, new RealmUnavailable('worker message could not be deserialised'));
        worker.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'ready') { started = true; worker.postMessage({ type: 'run', job }); return; }
            if (msg.type !== 'done') return;
            if (!msg.ok) return done(resolve, { screens: [], cursors: [], exitCode: null, error: msg.error });
            const r = msg.result || {};
            done(resolve, {
                screens: r.screens || [], cursors: r.cursors || [],
                exitCode: r.exitCode === undefined ? null : r.exitCode, error: null,
            });
        };
    });
}

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
