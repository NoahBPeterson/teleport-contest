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
//     game would resume the first one's dungeon. `claimed` below enforces it,
//     and so does globalThis.__c2jsEngineRealmUsed, which this engine sets and
//     which js/jsmain.js's runSegment and ReplayEngine's last-resort in-page
//     boot both read. A second game goes to a transport or to a ReplayEngine
//     realm; a second game in a browser with no Worker at all gets a refusal
//     in words. Verified by tools/judge-sim/multigame-repro.html.
//   - It cannot be retired cheaply. A worker can be terminated; a module graph
//     in the page realm cannot be unloaded. So this engine must never be
//     started speculatively alongside a transport that might win — it is
//     started in the fallback's slot, after FALLBACK_HEAD_START_MS, exactly
//     where ReplayEngine used to be.

import { makeFrameReader } from './frames.mjs';

/** The page realm can host exactly one of these. */
let claimed = false;

/**
 * The yieldable module graph, once somebody has asked for it.
 *
 * Instantiating it is job-independent — no generated module reads a harness
 * global at module scope, which is the same property the worker prewarm relies
 * on (docs/NOTES-transport-ladder.md, "What is warmed, and why it needs no
 * seed") — so it can be paid before there is a game to play, and a boot that
 * arrives later joins the import already in flight instead of starting a
 * second one.
 */
let graph = null;
/** ...and whether it has finished, which is the question `warmed` asks. */
let graphReady = false;

/**
 * Instantiate the yieldable graph in this realm, and nothing else. Runs no C
 * code: every C file-scope variable is still at its static initialiser
 * afterwards, so the realm is as pristine as it was before.
 *
 * Called by prewarmEngine() in js/boot/interactive.mjs *only* once the
 * transports have been ruled out, because in a realm that has a transport this
 * import is 13.6 MB of main-thread compile-and-evaluate that nobody will use.
 * Never throws: a tree without a yieldable build simply has no rung here, and
 * the caller has nothing to report to.
 */
export function prewarmMainThread() {
    if (!graph) {
        graph = (async () => {
            const { installBrowserGlobals } = await import('./browser-env.mjs');
            installBrowserGlobals();
            // Not statically imported: a tree built without the yieldable
            // engine must still load js/boot/interactive.mjs.
            return import('./harness-y.mjs');
        })();
        // Attached here rather than by the caller, so a rung nobody ends up
        // using can never surface as an unhandled rejection — which is a
        // console line, which fails the run.
        graph.then(() => { graphReady = true; }, () => { /* no yieldable build */ });
    }
    return graph;
}

export class MainThreadEngine {
    constructor(job) {
        this.job = job;
        this.mode = 'main';
        this.frame = null;
        this.exited = false;
        this.exitInfo = null;
        // True when the yieldable graph was already instantiated in this realm
        // before this game asked for it — the main-thread rung's half of the
        // prewarm, and the same field the transports report.
        this.warmed = false;
        // The two halves of a main-thread first frame, kept apart because the
        // question "is warming this rung's graph worth anything?" is exactly
        // the ratio between them, and the answer is not what the Node profile
        // in docs/NOTES-transport-ladder.md predicted. Reported by
        // index.html's ?bench= run as main_graph_ms / main_boot_ms.
        this.graphMs = undefined;   // instantiate js/generated-y/**
        this.bootMs = undefined;    // newgame(), to the first getchar() park
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

    /**
     * Boot, and run to the first park — which is the first painted frame.
     *
     * `cancelled` is asked between the two halves of that (instantiate the
     * graph; run newgame). Both halves block the page's event loop outright —
     * they are transpiled C and 13.6 MB of module evaluation, neither of which
     * can be interleaved with anything — and while the thread is blocked no
     * transport's `ready`, no service worker's probe answer and no timer can be
     * serviced. So there is exactly one seam here, and it is used for two
     * things at once: give the race a chance to say the second half is no
     * longer wanted, and give every message queued behind the first half a turn
     * of the event loop in which to be delivered. It is the only point in a
     * main-thread boot where anything else in the page can run at all.
     */
    async start(cancelled) {
        if (claimed) throw new Error('the page realm has already hosted a resident engine');
        // `claimed` is set below, not here, and that is the point: neither the
        // refusal above nor a rejection out of the import below is a claim on
        // this realm. Both mean "this rung is unavailable", the caller answers
        // both by using ReplayEngine, and a realm that never ran a game must
        // still be able to host one.
        //
        // Asked of `graphReady` rather than `graph`: "somebody has started the
        // import" is not the claim being made — the transports' `warmed` means
        // the realm has the graph in hand, and this has to mean the same thing
        // to be in the same column.
        this.warmed = graphReady;
        const tGraph = performance.now();
        const harness = await prewarmMainThread();
        this.graphMs = performance.now() - tGraph;
        if (cancelled && cancelled()) throw new Error('fallback cancelled before boot');
        // One real task boundary, not a microtask: `await` on an already-
        // resolved promise resumes inside the same task and would service no
        // message at all. See the doc comment above.
        await new Promise((res) => setTimeout(res, 0));
        if (cancelled && cancelled()) throw new Error('fallback cancelled before boot');
        if (claimed) throw new Error('the page realm has already hosted a resident engine');
        claimed = true;
        // Say so where the rest of the tree looks. js/jsmain.js's runSegment
        // and ReplayEngine's last-resort in-page boot both ask this one
        // question — "has transpiled C run in this realm?" — and both must get
        // yes from here on, because the hand-written runtime under the two
        // module graphs is shared (js/cptr.js's VFS fd table, its pointer
        // registry) even though the graphs themselves are not. A later game or
        // a later scored segment must go to a realm of its own, or say why it
        // cannot; neither may quietly land in this arena.
        globalThis.__c2jsEngineRealmUsed = true;
        const { runBootGame } = harness;

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
        this.bootMs = performance.now() - tGraph - this.graphMs;
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

    /**
     * The same measurement the worker engines report, in the same shape, so
     * the bench's `engine_ms_per_move` column is comparable across every rung.
     * On this one the answer is nearly the whole of `ms_per_move`: there is no
     * thread hop to subtract.
     */
    get engineTime() { return this._steps ? { ms: this._engineMs, steps: this._steps } : undefined; }

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
