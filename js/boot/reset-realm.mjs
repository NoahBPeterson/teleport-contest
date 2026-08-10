// reset-realm.mjs — one module graph, many games.
//
// THE PROBLEM THIS SHARES WITH isolation.mjs. js/generated/* is transpiled C:
// every C file-scope variable is a module-scope variable, so re-running main()
// in a graph that already played a game starts from the previous game's
// globals. isolation.mjs solves that by *forking* the graph — a distinct
// `?c2jsseg=N` URL is a distinct script to V8, so segment N gets 176 freshly
// parsed, freshly evaluated modules.
//
// WHAT IT COSTS. A distinct script is also a distinct *parse*: forks 2..N cost
// what fork 1 cost (measured, docs/PROFILE-2026-08.md §5.1: 490/401/440/439 ms
// for four consecutive forks) and a forked graph can never be unloaded, so each
// one strands ~70 MB for the life of the process. A ten-segment session pays
// both bills ten times inside one child.
//
// WHAT THIS DOES INSTEAD. Keep the graph and put its state back. Every
// generated module carries an emitted `__resetState()` (tools/c2js/resetify.mjs)
// that re-assigns its top-level bindings to their recorded initial values and
// refills its byte arenas from a snapshot taken at first instantiation;
// js/generated/__reset.js is the barrel that captures and drives all of them,
// js/cptr.js resets the pointer registry that sits underneath them. The result
// has to be *byte-identical* to a fresh realm, not merely "clean" — that is
// what tools/reset-diff.mjs exists to prove, and it is the only reason to
// believe this instead of the fork.
//
// THE ORDERING THAT MAKES IT EXACT. cptr's `addr()` hands out buffer ids from a
// counter on first touch, and C hashes those ids, so id assignment is
// parity-observable. Two facts make the reset exact rather than approximate:
// (1) evaluating the graph assigns *no* ids at all (measured: `__nextBufId` is
// still 1 when the last of the 176 modules finishes), so a reset that puts the
// counter back to its captured value reproduces a fresh realm's numbering
// exactly, provided (2) the reset also drops the identity map, so segment 2's
// first touch of a buffer is a *first* touch again. cptr.js's `__resetState()`
// does both, and replays the (empty, but not assumed-empty) prefix of
// assignments made before the capture point so the invariant survives a future
// graph that does take an address at evaluation time.
//
// FLAG-GATED BUILD. The barrel and the per-module `__resetState()` exist only
// in a `C2JS_RESET=1` build. Without them `acquire()` still works and `reset()`
// reports `false` — callers must treat that as "this realm is spent", never as
// "reset succeeded".

import { enableSegmentIsolation, segmentSpecifier } from './isolation.mjs';

const HARNESS_URL = new URL('./harness.mjs', import.meta.url).href;
const BARREL_URL = new URL('../generated/__reset.js', import.meta.url).href;

// Fork tags are per *process*: two resettable realms in one process must not
// collide with each other, nor with the tags js/jsmain.js hands out. Tags from
// here are negative for exactly that reason — jsmain counts up from 1.
let __tagCounter = 0;

/**
 * One module graph plus the handle that puts it back.
 *
 * `runBootGame` is this realm's copy — NOT the shared one — so a caller that
 * holds two realms cannot accidentally drive the wrong graph.
 */
export class Realm {
    constructor(tag, runBootGame, barrel) {
        this.tag = tag;
        this.runBootGame = runBootGame;
        this._barrel = barrel;
        /** ms spent in the most recent reset(), for the profile. */
        this.lastResetMs = 0;
        /** how many games this graph has run. */
        this.generation = 0;
        this._dirty = false;
    }

    /** True when this realm can actually be put back (a C2JS_RESET=1 build). */
    get resettable() { return this._barrel !== null; }

    /**
     * Run one segment in this realm, resetting first if it already ran one.
     *
     * Resetting *before* rather than *after* is deliberate: it keeps the spent
     * game's state readable for as long as anyone might want to look at it
     * (a failing differential run wants exactly that), and it means a realm
     * that is never reused never pays for a reset at all.
     *
     * @returns {Promise<object>} runBootGame's result, unmodified.
     */
    async run(opts) {
        if (this._dirty) {
            if (!this.reset()) {
                throw new Error('reset-realm: this graph already ran a game and '
                    + 'cannot be reset (build without C2JS_RESET=1); a second '
                    + 'game here would replay into the first game\'s C globals');
            }
        }
        this._dirty = true;
        this.generation++;
        return this.runBootGame(opts);
    }

    /**
     * Put the graph back to the state it was in when it finished evaluating.
     * @returns {boolean} false when this build cannot do it (nothing happened).
     */
    reset() {
        if (this._barrel === null) return false;
        const t0 = performance.now();
        this._barrel.resetAll();
        this.lastResetMs = performance.now() - t0;
        this._dirty = false;
        return true;
    }
}

/**
 * Acquire a realm: a private copy of the generated graph, armed for reset.
 *
 * MUST be called after installBrowserGlobals() — arming evaluates all 176
 * generated modules, and their top-level code runs against whatever globals are
 * installed at that moment. Arming before would snapshot a graph that a real
 * boot never produces.
 *
 * @param {{fork?: boolean, arm?: boolean}} [opts] fork:false reuses the *shared*
 *        graph (only sane for the very first realm in a process, and only when
 *        nothing else has run a game in it). arm:false skips the snapshot, for
 *        a realm that is knowingly going to run exactly one game — it is then
 *        indistinguishable from what js/jsmain.js:runSegment acquires today,
 *        which is what makes such a realm usable as a differential *reference*.
 */
export async function acquire(opts) {
    const fork = !(opts && opts.fork === false);
    const arm = !(opts && opts.arm === false);
    let tag = 0;
    let harnessUrl = HARNESS_URL;
    let barrelUrl = BARREL_URL;
    if (fork) {
        const isolated = await enableSegmentIsolation({ quiet: true });
        if (!isolated) {
            throw new Error('reset-realm: cannot fork a graph to own '
                + '(module.registerHooks unavailable), and taking the shared '
                + 'one would be a lie about isolation');
        }
        tag = --__tagCounter;
        harnessUrl = segmentSpecifier(HARNESS_URL, tag, true);
        barrelUrl = segmentSpecifier(BARREL_URL, tag, true);
    }

    const { runBootGame } = await import(harnessUrl);

    // The barrel is what evaluates the graph and takes the pristine snapshot.
    // Its absence is a build without C2JS_RESET=1, which is a supported (if
    // degraded) configuration: the realm still runs exactly one game.
    let barrel = null;
    if (!arm) return new Realm(tag, runBootGame, null);
    try {
        barrel = await import(barrelUrl);
        barrel.captureAll();
    } catch (e) {
        if (!isModuleNotFound(e)) throw e;
        barrel = null;
    }

    return new Realm(tag, runBootGame, barrel);
}

function isModuleNotFound(e) {
    return !!e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND');
}
