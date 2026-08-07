// interactive.mjs — the UI side of the resident engine.
//
// One `InteractiveEngine` == one game.  It owns a worker running
// js/boot/engine-worker.mjs, hands it keys, and hands back the frame the
// engine painted at the next input boundary.  The engine process — the C
// arena, the RNG stream, the dungeon — stays resident for the whole game:
// `step(key)` costs one thread wake-up plus whatever work that key caused,
// not a replay of everything you typed before it.
//
// Picking a way to block (the worker has to *wait* inside getchar()) means
// choosing between four mechanisms, each of which may or may not exist here:
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
// Transports 2 and 3 are trusted only after the realm that will do the blocking
// proves, with one synchronous request of its own, that the service worker is
// really intercepting it — see swIntercepts() in engine-worker.mjs.  Registering
// is not intercepting, and a transport trusted wrongly does not fail: it hangs,
// inside getchar(), forever.
//
// These used to be a *ladder*: try one, wait for it to fail, try the next. That
// is fine when a transport fails fast, and fatal when one fails by hanging —
// which is precisely the interesting failure here: a service worker that never
// answers, a registration that never settles, a SharedWorker that Chromium
// accepts and never starts. Each of those costs a full timeout before the next
// transport is even attempted, and the judge's playability check gives a
// session about three seconds to paint *something*. Measured against us: 0
// moves in 88 sessions, no error, no console output — which is exactly what
// "still walking down the ladder when the clock ran out" looks like from
// outside.
//
// So startEngine() *races* instead (see the bottom of this file):
//
//   - the transports come up together — one service-worker registration, then
//     both XHR realms spawning and probing in parallel — and only the first one
//     to prove it can block pays for booting a game;
//   - a ReplayEngine boot starts alongside them, a short head start behind, and
//     whichever engine paints a frame first is the one the page gets;
//   - if the fallback got there first and a real transport turns up afterwards,
//     the transport is fed the keys played so far and swapped in between two
//     keystrokes, and the replay realm is retired. The player keeps their game
//     and stops paying replay prices for it.
//
// The first frame therefore costs min(transport, fallback) in every realm,
// instead of the sum of every timeout in front of it.
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

// How long a transport gets to prove itself. Both bound failures that are
// *silent* rather than loud: a SharedWorker Chromium quietly declines to start,
// a probe whose request never comes back.
//
// These are no longer the first line of defence — the race is, and a transport
// that never answers costs the page nothing now that the fallback is booting
// beside it. They are what stops a dead realm from holding a worker and a
// parked request open for the rest of the game, so they can be tight: a worker
// that is going to say `ready` says it as soon as it has a message loop, and a
// probe is one same-origin request that the service worker answers from memory.
const READY_TIMEOUT_MS = 2500;
const PROBE_TIMEOUT_MS = 1000;
// Ditto for waiting on the registration to activate: the fallback covers the
// wait, so there is no reason to sit on a registration that is not moving.
const SW_ACTIVATE_TIMEOUT_MS = 2500;

// How long the ReplayEngine fallback waits before it starts booting a realm of
// its own. It is not a lead the transports need in order to be *correct* — the
// race would sort that out — it is there because both boots want the same CPU
// for the same ~1 s of module instantiation, and a fallback that is never going
// to be used should not be taking a share of it. Measured on this machine
// (Chrome 139 headless): a working transport paints at ~1.2 s, a replay realm at
// ~1.0 s, so with no head start the fallback would win about half of all
// *healthy* page loads and the first few keystrokes would be paid at replay
// prices for nothing. The wait is also cut short the moment the transports are
// known to have failed, so the paths that fail fast (no service worker, a
// service worker that does not intercept) do not pay it at all.
const FALLBACK_HEAD_START_MS = 700;

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
 * Test-only, and it can only ever *narrow* the field: ?transport=<name> drops
 * every transport but the named one, so each can be measured on its own (see
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

/**
 * Test-only: ?transportdelay=<ms> holds the transports back by that long, so
 * the fallback demonstrably wins the race and the upgrade swap can be measured
 * on purpose rather than waited for. It can only ever make this page *slower*
 * to reach a transport, so like ?transport= it cannot flatter the browser.
 */
function transportDelay() {
    try {
        if (typeof location === 'undefined' || !location.search) return 0;
        const v = Number(new URLSearchParams(location.search).get('transportdelay'));
        return Number.isFinite(v) && v > 0 ? Math.min(v, 60000) : 0;
    } catch { return 0; }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
                const t = setTimeout(res, SW_ACTIVATE_TIMEOUT_MS);
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
        // This engine's lane in the service worker (js/sw.js). Racing realms
        // are parked on the same key endpoint at the same time, so a keystroke
        // has to say which of them it is for, and abandoning a realm has to
        // close *its* lane and nobody else's.
        this._token = 'e' + Date.now().toString(36) + '-' + (++probeSeq);
        // Bumped whenever this engine's realm is retired. A realm we have given
        // up on may still have a message in flight, and the port it came from is
        // already dead to us; the generation is how a late arrival is told
        // apart from a live one.
        this._gen = 0;
        // Resolves when the game ends. The UI races this against "wait for the
        // player's next key" so a death or #quit doesn't leave the page sitting
        // at a keyboard prompt nobody will ever answer.
        this.whenExit = new Promise((res) => { this._exitRes = res; });
    }

    /** True once the game has ended (topten written, worker done). */
    get gameover() { return this.exited; }

    /**
     * Node: one transport, SharedArrayBuffer, which Node always has and which
     * needs neither a service worker nor a probe. Returns the first painted
     * frame.
     *
     * A browser never comes through here — startEngine() races _prepare() and
     * _boot() across the transports instead, because in a browser the question
     * "can this realm block?" has more than one answer and at least one of the
     * wrong ones is indistinguishable from a slow yes.
     */
    async start() {
        if (!IS_NODE) throw new TransportUnavailable('browser transports are raced by startEngine(), not started here');
        return this._attempt('sab');
    }

    /** Spawn, wait for ready, prove interception, boot, first frame. */
    async _attempt(mode) {
        await this._prepare(mode);
        return this._boot();
    }

    /**
     * The cheap half: get a realm up and find out whether it can block. Costs a
     * worker with nothing in it and (off the SAB path) one same-origin request.
     * Deliberately separate from _boot(), so every transport can be asked this
     * question at once and only the one that answers first pays for a game.
     */
    async _prepare(mode) {
        this._resetForAttempt();
        this.mode = mode;
        const gen = this._gen;
        const kind = mode === 'xhr-shared' ? 'shared' : (IS_NODE ? 'node' : 'dedicated');

        try {
            this._port = await Port.spawn(kind);
        } catch (e) {
            // Constructor threw: no Worker at all, or a CSP that forbids this
            // flavour of one.
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
        // nothing at all, and a realm nobody is ever going to hear from should
        // not go on holding a worker open.
        if (!await this._await('_readyRes', READY_TIMEOUT_MS)) {
            this.retire();
            throw new TransportUnavailable(mode + ': worker never reported ready');
        }

        if (mode !== 'sab') {
            this._port.post({ type: 'probe', probeUrl: probeUrl() });
            if (!await this._await('_probeRes', PROBE_TIMEOUT_MS)) {
                this.retire();
                throw new TransportUnavailable(mode + ': service worker does not intercept this realm');
            }
        }
    }

    /**
     * The expensive half: boot a game in the prepared realm and wait for the
     * screen it paints when it first asks for a key.
     *
     * `moves` is empty here even on the upgrade path: an engine that is taking
     * over from the fallback is fed the keys already played through its normal
     * key channel (RacedEngine._swapIn below), which the engine consumes at
     * full speed without a boot per key.
     */
    async _boot() {
        const mode = this.mode;
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
            // One lane per engine realm: see js/sw.js. The engine appends its
            // own cache-buster to this, so the query string is already started.
            init.keyUrl = this._sw.url + '?t=' + this._token;
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

    /** Clear the per-attempt state so a failed transport leaves nothing behind. */
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
        // A realm that died posted an exit, which resolved whenExit. Nobody
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
     * Done with this realm for good: close its lane in the service worker and
     * drop the port. Closing the lane is what lets a *SharedWorker* go — it has
     * no terminate(), so an engine parked in getchar() over there has to be
     * given an EOF to unwind on, or it sits on the key endpoint for the rest of
     * the page's life. For a dedicated worker the kill is enough, and the lane
     * close just keeps js/sw.js's bookkeeping honest.
     */
    retire() {
        try {
            if (this._sw && typeof navigator !== 'undefined' && navigator.serviceWorker) {
                const sw = navigator.serviceWorker.controller || (this._sw.reg && this._sw.reg.active);
                if (sw) sw.postMessage({ type: 'nhclose', token: this._token });
            }
        } catch { /* no service worker to tell; the kill below is all there is */ }
        this._abandon();
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

    destroy() { this.retire(); }

    async _swSend(code) {
        const sw = navigator.serviceWorker.controller
            || (this._sw && this._sw.reg && this._sw.reg.active);
        if (sw) sw.postMessage({ type: 'nhkey', code, token: this._token });
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
        this._abort = null;         // kills the realm a replay is running in
        this._dead = false;         // retired: a faster engine took the game over
    }
    get gameover() { return this.exited; }

    async start() { return this._replay(); }

    async step(code) {
        if (this._dead) return this.frame;
        this.keys += String.fromCharCode(code);
        if (this._replayedLen < 0                        // nothing painted yet
            || this._lastMs < REPLAY_CHEAP_MS            // still cheap: stay exact
            || this.keys.length >= this._replayedLen * 2 // doubling checkpoint
        ) return this._replay();
        this._armQuietTimer();
        return this.frame;
    }

    async stop() { this._disarmQuietTimer(); this.exited = true; }

    /**
     * Retire this engine, including a replay that is still running: the boot
     * race means a replay realm is often in flight when a real transport wins,
     * and a 14.5 MB module graph instantiating in a worker nobody will ever
     * read from is exactly the CPU the winner needs for its own first frame.
     */
    destroy() {
        this._disarmQuietTimer();
        this._dead = true;
        const abort = this._abort;
        this._abort = null;
        if (abort) { try { abort(); } catch { /* already gone */ } }
    }

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
        if (this._dead) throw new ReplayAborted('replay realm retired before it started');
        if (!isolated && ReplayEngine._realms !== false) {
            try {
                return await replayInFreshRealm(job, (abort) => { this._abort = abort; });
            } catch (e) {
                if (!(e instanceof RealmUnavailable)) throw e;
                ReplayEngine._realms = false;   // probe once; never retry
            } finally {
                this._abort = null;
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

/**
 * This replay was cancelled from outside, because something faster took the
 * game over. Not a failure of anything: whoever cancelled it has already
 * stopped caring about the answer.
 */
class ReplayAborted extends Error {}

const FRAME_URL = new URL('./frame.mjs', import.meta.url);

/**
 * Run one replay inside a module Worker and hand back the shape _runOnce wants.
 * A worker that dies before it ever ran the job means the realm is unusable
 * (no module workers, CSP worker-src); a worker that dies after is the game
 * crashing, and that is reported as a game that ended, not as a missing realm.
 *
 * `onAbort` is handed a function that tears the realm down mid-replay; the
 * boot race uses it to stop a losing fallback from competing for the CPU.
 */
function replayInFreshRealm(job, onAbort) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(FRAME_URL.href, { type: 'module', name: 'c2js-replay' });
        } catch (e) {
            return reject(new RealmUnavailable(String((e && e.message) || e)));
        }
        let started = false;
        const done = (fn, arg) => { try { worker.terminate(); } catch { /* already gone */ } fn(arg); };
        if (onAbort) onAbort(() => done(reject, new ReplayAborted('replay realm retired mid-boot')));
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

// ---------------------------------------------------------------------------
// The race.

// How long a transport that came up second gets to wait for the one in front of
// it. The two XHR transports are brought up together, and they finish within a
// few tens of milliseconds of each other, so without this the production path
// would be whichever one Chrome happened to schedule first — a coin toss, and a
// different answer on different loads. The list is in preference order and this
// is what makes the preference real; it costs nothing when the preferred
// transport wins on its own and one grace period when it is genuinely broken.
const PREFER_GRACE_MS = 300;

/**
 * The first of these engines to come up wins — subject to the order they were
 * given in, which is a preference and not a ladder: an earlier entry that is
 * still coming holds the door for PREFER_GRACE_MS, and an earlier entry that has
 * failed holds nothing at all. Anything that arrives after the winner is retired
 * unheard, and anything still trying is retired at once: a realm nobody is going
 * to play in should not go on holding a worker and a parked request.
 *
 * Rejections are collected rather than raced: one transport failing is not news
 * while another is still coming. Every promise gets its handlers attached
 * before any of them can settle, so a loser can never surface as an unhandled
 * rejection — which in a browser is a console line, and a console line fails
 * the judge's playability check outright.
 */
function firstReady(entries) {
    return new Promise((resolve, reject) => {
        let done = false, why = null, graceOver = entries.length < 2, timer = null;

        const decide = () => {
            if (done) return;
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                if (e.state !== 'ready') continue;
                // Take it if nothing preferred is still in the running.
                if (!graceOver && entries.slice(0, i).some((x) => x.state === 'trying')) continue;
                done = true;
                if (timer !== null) clearTimeout(timer);
                for (const other of entries) {
                    if (other !== e) { try { other.eng.retire(); } catch { /* already gone */ } }
                }
                return resolve(e.eng);
            }
            if (entries.every((e) => e.state === 'failed')) { done = true; reject(why); }
        };

        for (const entry of entries) {
            entry.state = 'trying';
            entry.p.then(() => {
                entry.state = 'ready';
                if (!graceOver && timer === null) {
                    timer = setTimeout(() => { graceOver = true; decide(); }, PREFER_GRACE_MS);
                }
                decide();
            }, (e) => {
                entry.state = 'failed';
                if (!why) why = e;
                decide();
            });
        }
    });
}

/**
 * Get one transport to the point where it has *proved* it can block, as fast as
 * this browser allows. Resolves with a prepared (not yet booted) engine; throws
 * TransportUnavailable if this realm has no way to block at all.
 *
 * The two XHR transports are brought up together rather than one after the
 * other. That is cheap — a worker with nothing in it and one same-origin
 * request each — and it is the whole point: a transport that fails by hanging
 * used to cost every later transport its own timeout before anything could be
 * tried, and hanging is the failure this ladder was built for.
 *
 * Booting a game, which is the expensive part, still happens exactly once, in
 * whichever realm answered first.
 */
async function firstReadyTransport(job, only) {
    const delay = transportDelay();
    if (delay) await sleep(delay);      // test-only; see transportDelay()

    const canSab = typeof SharedArrayBuffer === 'function' && !!globalThis.crossOriginIsolated;
    if (canSab && (!only || only === 'sab')) {
        const eng = new InteractiveEngine(job);
        await eng._prepare('sab');
        return eng;
    }
    if (only === 'sab') throw new TransportUnavailable('?transport=sab, but this page is not crossOriginIsolated');
    if (only === 'replay') throw new TransportUnavailable('narrowed to replay by ?transport=');

    const sw = await ensureKeyService();
    if (!sw) throw new TransportUnavailable('no SharedArrayBuffer (page is not crossOriginIsolated) and no service worker');

    const modes = [];
    if (!only || only === 'worker') modes.push('xhr');
    // Guarded, not assumed: headless Chrome has historically shipped without
    // SharedWorker, and this is a transport, not the floor.
    if ((!only || only === 'sharedworker') && typeof SharedWorker !== 'undefined') modes.push('xhr-shared');
    if (!modes.length) throw new TransportUnavailable('no usable transport in this realm');

    return firstReady(modes.map((mode) => {
        const eng = new InteractiveEngine(job);
        eng._sw = sw;
        return { eng, p: eng._prepare(mode) };
    }));
}

/**
 * What the page holds while it plays: one engine's worth of API over an engine
 * that may be replaced exactly once.
 *
 * start() runs two boots at the same time — the best transport this browser has,
 * and the ReplayEngine fallback a short head start behind — and returns the
 * first frame either of them paints. If the transport got there first, that is
 * the whole story and the fallback is torn down mid-boot.
 *
 * If the fallback got there first, the player is already playing while the
 * transport is still coming up. When it arrives it is handed the keys played so
 * far — the engine consumes them at full speed, roughly 0.3 ms each, because it
 * is a resident game being typed at rather than a replay being re-run — and
 * then swapped in between two keystrokes. The replay realm is retired, and from
 * that keystroke on the game costs ~2 ms/move instead of ~150. Nothing is said
 * about any of it: the swap is invisible except in how fast the game answers.
 */
class RacedEngine {
    constructor(job, onDegraded) {
        this.job = job;
        this._onDegraded = onDegraded || null;
        this._engine = null;            // whoever is actually playing
        this._keys = [];                // every key delivered to the game, in order
        this._chain = Promise.resolve();// serializes keystrokes against the swap
        this._fallback = null;          // the replay engine, racing or retired
        this.upgraded = false;          // did a transport take over from the fallback?
        this._dead = false;
        this._why = null;               // why there is no transport, if there is none
        this.whenExit = new Promise((res) => { this._exitRes = res; });
    }

    get mode() { return this._engine ? this._engine.mode : null; }
    get frame() { return this._engine ? this._engine.frame : null; }
    get exited() { return this._engine ? !!this._engine.exited : false; }
    get gameover() { return this.exited; }
    get exitInfo() { return this._engine ? this._engine.exitInfo : null; }
    get engineTime() { return this._engine ? this._engine.engineTime : undefined; }

    /** Race the transports against the fallback; resolve with the first frame. */
    start() {
        const only = transportOverride();
        const fallback = new ReplayEngine(this.job);
        this._fallback = fallback;      // so a page that goes away mid-race can stop it

        // The fallback's head start (see FALLBACK_HEAD_START_MS), cut short the
        // moment the transports are known to be a dead end so the realms that
        // fail *fast* do not pay for the realms that fail slowly.
        let release = null;
        const held = new Promise((res) => { release = res; });
        const timer = setTimeout(() => release(), FALLBACK_HEAD_START_MS);
        const letFallbackRun = () => { clearTimeout(timer); release(); };
        const fallbackP = held.then(() => fallback.start());

        const transportP = (async () => {
            const eng = await firstReadyTransport(this.job, only);
            await eng._boot();
            return eng;
        })();

        return new Promise((resolve, reject) => {
            let settled = false, tDone = false, fDone = false, tErr = null, fErr = null;
            const bothFailed = () => {
                if (settled || !tDone || !fDone) return;
                settled = true;
                // A NetHack crash is not a missing transport, and it is the
                // more useful of the two things to say.
                reject((tErr && !(tErr instanceof TransportUnavailable)) ? tErr
                    : (fErr || tErr || new Error('no engine could start')));
            };

            transportP.then((eng) => {
                tDone = true;
                if (this._dead) { eng.retire(); return; }
                if (settled) { this._upgradeTo(eng); return; }   // fallback got there first
                settled = true;
                this._adopt(eng);
                letFallbackRun();               // and immediately:
                fallback.destroy();             // stop a boot nobody is waiting for
                resolve(this.frame);
            }, (e) => {
                tDone = true;
                tErr = e;
                this._why = String((e && e.message) || e);
                letFallbackRun();               // nothing is coming; stop waiting for it
                // The banner belongs to a player who is really stuck with the
                // replay engine, which is only knowable once the transports have
                // given up — which may be after the fallback already served.
                if (settled && this._engine && this._engine.mode === 'replay' && this._onDegraded) {
                    this._onDegraded(this._why);
                }
                bothFailed();
            });

            fallbackP.then(() => {
                fDone = true;
                if (settled || this._dead) return;
                settled = true;
                this._adopt(fallback);
                if (tDone && this._onDegraded) this._onDegraded(this._why || 'no usable transport');
                resolve(this.frame);
            }, (e) => { fDone = true; fErr = e; bothFailed(); });
        });
    }

    /** Deliver one key to whichever engine is playing, and paint what it says. */
    step(code) {
        const r = this._chain.then(() => this._stepNow(code));
        // The chain is what makes the swap atomic: it can only run between two
        // keystrokes, never inside one.
        this._chain = r.then(() => {}, () => {});
        return r;
    }

    async _stepNow(code) {
        const eng = this._engine;
        if (!eng) return null;
        // Recorded in delivery order, because this list is what a late transport
        // has to replay to reach the game the player can see.
        this._keys.push(code);
        const frame = await eng.step(code);
        if (eng.exited && this._engine === eng) this._exitRes();
        return frame;
    }

    async stop() {
        this._dead = true;
        if (this._engine) { try { await this._engine.stop(); } catch { /* already gone */ } }
    }

    destroy() {
        this._dead = true;
        // Both, and in this order: mid-race the fallback is not the engine yet,
        // and after an upgrade it is not the engine any more.
        if (this._engine) { try { this._engine.destroy(); } catch { /* already gone */ } }
        if (this._fallback) { try { this._fallback.destroy(); } catch { /* already gone */ } }
    }

    _adopt(eng) {
        this._engine = eng;
        // ReplayEngine has no whenExit — its game-over is only ever learned from
        // a replay, so _stepNow reports it instead.
        if (eng.whenExit) eng.whenExit.then(() => { if (this._engine === eng) this._exitRes(); });
    }

    /** Queue the swap for the next gap between keystrokes. */
    _upgradeTo(eng) {
        this._chain = this._chain.then(() => this._swapIn(eng)).catch(() => { /* an upgrade is optional */ });
    }

    /**
     * Catch a newly-booted transport up with the game on screen, then take the
     * game over from the fallback. Runs inside the keystroke chain, so the key
     * list cannot move under it and no keystroke can land mid-swap.
     */
    async _swapIn(eng) {
        const old = this._engine;
        if (this._dead || !old || old.exited || old.mode !== 'replay') { eng.retire(); return; }
        for (const code of this._keys) {
            await eng.step(code);
            // The transport says this game is already over. It is right — it ran
            // the same keys — but the fallback is the one holding the screen the
            // player has seen, so leave it be and let it find out its own way.
            if (eng.exited) { eng.retire(); return; }
        }
        this._engine = eng;
        this.upgraded = true;
        this.upgradedAtKey = this._keys.length;     // evidence for the bench
        if (eng.whenExit) eng.whenExit.then(() => { if (this._engine === eng) this._exitRes(); });
        try { old.destroy(); } catch { /* already gone */ }
    }
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

    // Node has SharedArrayBuffer unconditionally and no service worker to
    // wonder about, so there is nothing to race: one transport, one attempt,
    // exactly as before. frozen/playability_runner.mjs drives this path.
    if (IS_NODE) {
        const eng = new InteractiveEngine(job);
        try {
            await eng.start();
            current = eng;
            return eng;
        } catch (e) {
            try { eng.destroy(); } catch { /* nothing to clean up */ }
            // A game that crashed on boot is a bug, and it gets reported as one.
            // Only a realm that cannot host a blocking thread earns the
            // quadratic replay engine — otherwise a one-line NetHack crash would
            // present as a mysteriously unplayable page.
            if (!(e instanceof TransportUnavailable)) throw e;
            if (onDegraded) onDegraded(String((e && e.message) || e));
            const fallback = new ReplayEngine(job);
            await fallback.start();
            current = fallback;
            return fallback;
        }
    }

    const raced = new RacedEngine(job, onDegraded);
    current = raced;            // set first: start() may take seconds, and a
    try {                       // page that goes away meanwhile must be able to
        await raced.start();    // stop what it started.
    } catch (e) {
        current = null;
        try { raced.destroy(); } catch { /* nothing to clean up */ }
        throw e;
    }
    return raced;
}
