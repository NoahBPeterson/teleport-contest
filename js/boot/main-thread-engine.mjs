// main-thread-engine.mjs — a resident NetHack on the browser main thread.
//
// Every other resident engine in this tree needs a realm that is allowed to
// block, because the transpiled C parks inside getchar() with a live JS stack
// forty frames deep and expects a byte back on that same stack. A page's main
// thread cannot block, which is why js/boot/interactive.mjs races three
// transports for one — Atomics.wait on a SharedArrayBuffer, or a synchronous
// XHR parked by js/sw.js, hosted in a dedicated or shared worker — and why the
// last resort, ReplayEngine, re-runs the whole key prefix at ~21 ms/move.
//
// This engine needs none of that. It runs js/generated-y/, the yieldable build
// (tools/c2js/yieldify.mjs): every function that can reach a keystroke read is
// a generator, so at a park the entire C stack is suspended in heap objects
// and there is no stack to hold. Control returns to the event loop; the next
// keypress resumes it. No worker, no SharedArrayBuffer, no service worker, no
// blocking, nothing to trust and therefore nothing that can hang.
//
// See docs/NOTES-async-engine.md for the colouring census, the corpus parity
// result (69/69 byte-exact) and the cost (+17% per move against the sync
// engine, ~1.44 ms/move measured in Node).
//
// TWO LIMITATIONS, both structural:
//
//   - One game per page. The engine instantiates the transpiled module graph
//     in the page's own realm and C file-scope state is global, so a second
//     game would resume the first one's dungeon. `claimed` below enforces it;
//     a second game falls back to ReplayEngine, which spawns fresh realms.
//   - It cannot be retired cheaply. A worker can be terminated; a module graph
//     in the page realm cannot be unloaded. So this engine must never be
//     started speculatively alongside a transport that might win — it is
//     started in the fallback's slot, after FALLBACK_HEAD_START_MS, exactly
//     where ReplayEngine used to be.

import { makeFrameReader } from './frames.mjs';

/** The page realm can host exactly one of these. */
let claimed = false;

export class MainThreadEngine {
    constructor(job) {
        this.job = job;
        this.mode = 'main';
        this.frame = null;
        this.exited = false;
        this.exitInfo = null;
        this.warmed = false;
        this.engineTime = undefined;
        this._dead = false;
        this._deliver = null;      // resolver the parked engine is waiting on
        this._onPark = null;       // one-shot: fires when the engine parks
        this._done = null;         // the runBootGame promise
        this._engineMs = 0;
        this._steps = 0;
        this._tDelivered = 0;
        this.whenExit = new Promise((res) => { this._exitRes = res; });
    }

    get gameover() { return this.exited; }

    /** Boot, and run to the first park — which is the first painted frame. */
    async start() {
        if (claimed) throw new Error('the page realm has already hosted a resident engine');
        claimed = true;

        const { installBrowserGlobals } = await import('./browser-env.mjs');
        installBrowserGlobals();
        // Not statically imported: a tree built without the yieldable engine
        // must still load js/boot/interactive.mjs. The caller treats a
        // rejection here as "this rung is unavailable" and uses ReplayEngine.
        const { runBootGame } = await import('./harness-y.mjs');

        const frames = makeFrameReader();
        const clock = typeof performance !== 'undefined' && performance.now ? performance : Date;

        // Called from inside getchar(), at the moment the engine parks. The
        // generator stack is already suspended, so the promise returned here
        // can be settled from anywhere, later, on any turn of the event loop.
        // That sentence is the whole difference from the worker engine, whose
        // equivalent callback must return a key synchronously.
        const residentKey = () => new Promise((res) => {
            if (this._tDelivered) { this._engineMs += clock.now() - this._tDelivered; this._steps++; }
            const { last, anim } = frames.take();
            if (last) this.frame = { screen: last.screen, cx: last.cx, cy: last.cy, anim };
            this._deliver = res;
            const park = this._onPark;
            this._onPark = null;
            if (park) park();
        });

        this._done = runBootGame({
            seed: this.job.seed,
            datetime: this.job.datetime,
            nethackrc: this.job.nethackrc || '',
            moves: '',                       // nothing queued: park at the first getchar
            storage: this.job.storage || null,
            stdoutSink: frames.sink,
            residentKey,
        }).then(
            (r) => this._finish(frames, r, null),
            (e) => this._finish(frames, null, e),
        );

        await this._parked();
        return this.frame;
    }

    /** Deliver one keystroke; resolve with the frame painted at the next park. */
    async step(code) {
        if (this._dead || this.exited) return this.frame;
        const deliver = this._deliver;
        if (!deliver) { this.exited = true; return this.frame; }
        this._deliver = null;
        const parked = this._parked();
        this._tDelivered = (typeof performance !== 'undefined' && performance.now ? performance : Date).now();
        deliver(code);
        // The engine may end instead of parking again (death, #quit), in which
        // case nothing will ever park — race the run's completion.
        await Promise.race([parked, this._done]);
        return this.frame;
    }

    async stop() {
        // Answer the parked engine with EOF so it unwinds its own C stack the
        // way the recorder's process death does, rather than being abandoned
        // mid-generator with its `finally` blocks unrun.
        const deliver = this._deliver;
        this._deliver = null;
        if (deliver) { deliver(-1); try { await this._done; } catch { /* ending is not an error */ } }
        this.exited = true;
    }

    /**
     * Give up this engine. A worker can be terminated and a replay realm can be
     * killed; a module graph in the page realm cannot be unloaded, so all this
     * can do is stop feeding it and stop believing it. Retiring one of these is
     * expensive in a way the other engines are not — which is why it is only
     * ever started in the fallback slot.
     */
    retire() {
        this._dead = true;
        const deliver = this._deliver;
        this._deliver = null;
        if (deliver) { try { deliver(-1); } catch { /* already gone */ } }
        const park = this._onPark;
        this._onPark = null;
        if (park) park();
    }

    destroy() { this.retire(); }

    /** engine-thread ms per keystroke, for tools/judge-sim/playability.mjs */
    get msPerMove() { return this._steps ? this._engineMs / this._steps : undefined; }

    _parked() {
        return new Promise((res) => { this._onPark = () => { this._onPark = null; res(); }; });
    }

    _finish(frames, r, err) {
        const { last, anim } = frames.take();
        if (last) this.frame = { screen: last.screen, cx: last.cx, cy: last.cy, anim };
        this.exited = true;
        this.exitInfo = err ? { error: err } : { exitCode: r ? r.exitCode : null, error: r ? r.error : null };
        this._deliver = null;
        const park = this._onPark;
        this._onPark = null;
        if (park) park();
        try { this._exitRes(this.exitInfo); } catch { /* already settled */ }
    }
}
