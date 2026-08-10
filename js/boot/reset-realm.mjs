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

/**
 * The two module graphs this tree can host a game in.
 *
 * `sync` is the scored build (js/generated/, js/boot/harness.mjs). `yield` is
 * tools/c2js/yieldify.mjs's whole-program rewrite of it (js/generated-y/,
 * js/boot/harness-y.mjs), which is what the interactive rungs run.
 *
 * The `tag` prefix is not cosmetic. The resolve hook copies whatever follows
 * `?c2jsseg=` verbatim, so a tag is a namespace, and the two graphs sit on ONE
 * hand-written runtime: `js/cptr.js?c2jsseg=-1` is a single module whichever
 * graph asked for it, so a scored realm and an interactive realm with the same
 * tag would share the pointer registry and the fd table. Same reasoning, and
 * the same `y`, as js/boot/main-thread-engine.mjs's own fork tags.
 */
const BUILDS = {
    sync: { harness: './harness.mjs', barrel: '../generated/__reset.js', tag: '' },
    yield: { harness: './harness-y.mjs', barrel: '../generated-y/__reset.js', tag: 'y' },
};

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
    constructor(tag, runBootGame, barrel, build, luaPort) {
        this.tag = tag;
        /** 'sync' (the scored graph) or 'yield' (the interactive one). */
        this.build = build || 'sync';
        this.runBootGame = runBootGame;
        this._barrel = barrel;
        /** js/lua-js/registry.mjs in THIS realm, or null — see acquire(). */
        this._luaPort = luaPort || null;
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
     * @returns {Promise<object>} runBootGame's result, detached — see below.
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
        return detach(await this.runBootGame(opts));
    }

    /**
     * Put the graph back to the state it was in when it finished evaluating.
     * @returns {boolean} false when this build cannot do it (nothing happened).
     */
    reset() {
        if (this._barrel === null) return false;
        const t0 = performance.now();
        // The Lua-script ports first: they hold a lua_State and a table of
        // interned C strings that live in the bytes the barrel is about to
        // rewrite. See js/lua-js/registry.mjs's __resetState.
        if (this._luaPort) this._luaPort.__resetState();
        this._barrel.resetAll();
        this.lastResetMs = performance.now() - t0;
        this._dirty = false;
        return true;
    }
}

/**
 * THE ONE THING A SHARED GRAPH BREAKS THAT A FORKED ONE DOES NOT.
 *
 * `runBootGame` returns `rngLog` as `rnd.getRngLog()`, which is `js/generated/
 * rnd.js`'s own `__rngLog` array — not a copy. Under the fork path that is
 * harmless: segment N's rnd.js is a module nothing else will ever run in, so
 * the array it hands back is effectively the caller's. Under reset it is the
 * SAME array the next game logs into, and worse, the reset restores it by
 * refilling it in place (that is the whole point of the by-value snapshot: a
 * binding another module captured must land on the same object). So a judge
 * that holds segment 1's game object, runs segment 2, and only then calls
 * `getRngLog()` would read an empty array — a scoring failure with no visible
 * cause, in the one observable the scorer weighs most heavily.
 *
 * One `slice()` per game closes it. The other four fields are built by
 * js/boot/harness.mjs out of its own locals (`inputFrames.map(...)`, a joined
 * string) and alias nothing in the graph, which is checked at the source rather
 * than assumed: js/boot/harness.mjs's return statement is the only place a
 * result is constructed.
 *
 * `luaLoads` (roadmap 1.10) is the same bug a second time, and it was found by
 * re-reading that return statement rather than by hitting it: js/lua-js/
 * registry.mjs's closeTrace() returns its own exported `loads` array, and
 * __resetState() empties it IN PLACE for the same reason the RNG log is refilled
 * in place — tools/lua-oracle.mjs and the harness both hold that binding. So it
 * gets the same slice. Its *records* are not copied and do not need to be: the
 * reset drops the array's contents, it does not rewrite the objects that were
 * in it, and each record is plain data the port built.
 *
 * `luaSource` is safe as it stands — sourceCensus() builds fresh arrays out of
 * `loads` and `unportedLua` on every call — and is left alone, because copying
 * something that is already a copy would only hide the next change to it.
 */
function detach(r) {
    if (!r) return r;
    const out = { ...r };
    if (r.rngLog) out.rngLog = r.rngLog.slice();
    if (r.luaLoads) out.luaLoads = r.luaLoads.slice();
    return out;
}

/**
 * Acquire a realm: a private copy of the generated graph, armed for reset.
 *
 * MUST be called after installBrowserGlobals() — arming evaluates all 176
 * generated modules, and their top-level code runs against whatever globals are
 * installed at that moment. Arming before would snapshot a graph that a real
 * boot never produces.
 *
 * @param {{fork?: boolean, arm?: boolean, build?: 'sync'|'yield'}} [opts]
 *        fork:false reuses the *shared* graph (only sane for the very first
 *        realm in a process, and only when nothing else has run a game in it —
 *        it is also the only option a browser has, which is what makes it worth
 *        keeping). arm:false skips the snapshot, for a realm that is knowingly
 *        going to run exactly one game — it is then indistinguishable from what
 *        js/jsmain.js:runSegment forks, which is what makes such a realm usable
 *        as a differential *reference*. build selects which of the two module
 *        graphs to own; see BUILDS.
 */
export async function acquire(opts) {
    const fork = !(opts && opts.fork === false);
    const arm = !(opts && opts.arm === false);
    const build = (opts && opts.build) || 'sync';
    const spec = BUILDS[build];
    if (!spec) throw new Error('reset-realm: unknown build "' + build + '"');

    let tag = 0;
    let harnessUrl = new URL(spec.harness, import.meta.url).href;
    let barrelUrl = new URL(spec.barrel, import.meta.url).href;
    if (fork) {
        const isolated = await enableSegmentIsolation({ quiet: true });
        if (!isolated) {
            throw new Error('reset-realm: cannot fork a graph to own '
                + '(module.registerHooks unavailable), and taking the shared '
                + 'one would be a lie about isolation');
        }
        tag = spec.tag + (--__tagCounter);
        harnessUrl = segmentSpecifier(harnessUrl, tag, true);
        barrelUrl = segmentSpecifier(barrelUrl, tag, true);
    }

    const { runBootGame } = await import(harnessUrl);

    // The barrel is what evaluates the graph and takes the pristine snapshot.
    // Its absence is a build without C2JS_RESET=1, which is a supported (if
    // degraded) configuration: the realm still runs exactly one game.
    let barrel = null;
    if (!arm) return new Realm(tag, runBootGame, null, build, null);
    try {
        barrel = await import(barrelUrl);
    } catch (e) {
        if (!isModuleNotFound(e)) throw e;
        barrel = null;
    }

    // THE THIRD LAYER, AND WHY IT IS IMPORTED HERE RATHER THAN LEFT TO BOOT.
    //
    // js/lua-js/* (roadmap 1.10) is hand-written state in this same realm, so
    // it needs the same treatment as the graph and as js/cptr.js — but its
    // *evaluation* also has to happen in the same place relative to the graph's
    // that a fresh realm puts it in, because the snapshot is taken immediately
    // afterwards. A fresh realm's order is: graph evaluates, registry.mjs
    // evaluates (js/boot/harness.mjs imports it right after unixmain.js, and
    // before main()), then the game runs. So: barrel first, which is what
    // evaluates the graph; registry second; capture third. Game 1's boot then
    // finds both already in the module map and changes nothing.
    //
    // Only when there IS a barrel. Without one this realm runs exactly one game
    // and never resets, and importing registry.mjs early would be a gratuitous
    // reordering of a graph that nothing is going to snapshot.
    //
    // Only for the sync build. tools/c2js/yieldify.mjs deliberately strips the
    // registry import out of js/boot/harness-y.mjs — js/lua-js drives
    // js/generated/, not js/generated-y/ — so a yield realm has no port layer
    // to reset and must not evaluate one.
    let luaPort = null;
    if (barrel) {
        if (build === 'sync') luaPort = await importLuaPort(tag, fork);
        barrel.captureAll();
        if (luaPort) luaPort.__captureState();
    }

    return new Realm(tag, runBootGame, barrel, build, luaPort);
}

/**
 * This realm's copy of js/lua-js/registry.mjs, or null on a tree without one.
 *
 * The specifier is built exactly the way js/boot/isolation.mjs's resolve hook
 * would build it for a tagged harness importing `../lua-js/registry.mjs`, so
 * this is the same module instance the harness will get — not a second copy.
 */
async function importLuaPort(tag, fork) {
    let url = new URL('../lua-js/registry.mjs', import.meta.url).href;
    if (fork) url = segmentSpecifier(url, tag, true);
    try {
        return await import(url);
    } catch (e) {
        if (isModuleNotFound(e)) return null;   // a tree without the ports
        throw e;
    }
}

function isModuleNotFound(e) {
    return !!e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND');
}
