// interp-state.mjs — get a handle on the lua_State the *interpreter* is using.
//
// WHY THIS EXISTS. The PoC port (oracle.lua) never needed it: a level script
// only ever calls C bindings that mutate NetHack's globals, so the port can
// drive those bindings from a lua_State of its own (bridge.mjs) and nothing
// downstream can tell. dungeon.lua and quest.lua are a different shape. They
// are pure data — one assignment of a nested table to a global — and the game
// reads that table *back out of the Lua state* after the chunk returns:
//
//   init_dungeons()   (dungeon.c:1254) lua_getglobal(L,"dungeon") + lua_next
//   com_pager_core()  (questpgr.c:501) lua_getglobal(L,"questtext") + getfield
//
// A table built in a port-owned state is invisible to both. The port has to
// put its table in the state `nhl_loadlua()` was handed — and that state is a
// local variable inside transpiled C (init_dungeons / com_pager_core each call
// nhl_init() for themselves), with no global holding it and no wrappable call
// site. `gl.luacore` is a different state (nhcore.lua's) and is not it.
//
// HOW WE GET IT ANYWAY. Lua allocates its whole state as one block, through
// the allocator the embedder supplied — here nhl_alloc() -> re_alloc() ->
// realloc(), and `realloc` is the harness's (js/boot/harness.mjs). So every
// lua_State this game creates passes through JS we own. lua_newstate() asks
// for exactly sizeof(LG) bytes and lays the state out at a fixed offset inside
// that block (js/generated/lstate.js:346-362):
//
//     l = (*f)(ud, NULL, LUA_TTHREAD, 1624);   // sizeof(LG)
//     L = l + 8;                               // LUA_EXTRASPACE
//     g = l + 208;                             // &((LG *)l)->g
//     ...
//     g->mainthread = L;                       // g + 264
//     g->frealloc   = f;                       // g + 0
//
// So: watch `realloc(NULL, 1624)`, and confirm a candidate by the two fields
// lua_newstate() fills in and never changes — `g->mainthread` must point back
// at `l + 8`, and `g->frealloc` must be a function. A self-referential pointer
// at a fixed offset is not something an unrelated 1,624-byte allocation
// produces by accident, and the check is structural rather than statistical.
//
// This is the same kind of knowledge registry.mjs's levelFingerprint() already
// uses to read `levl[x][y].typ` out of `svl` — struct offsets taken from the
// transpiler's own output. It reads memory the game owns; it does not modify
// js/generated and it changes nothing when the ports are off.
//
// SAFETY. Discovery is best-effort and always verified: a port that cannot
// find its state raises rather than silently doing nothing (see registry.mjs),
// so "the port quietly stopped running and the corpus still passed" is not a
// reachable state.

import * as cptr from '../cptr.js';
import { lua_getglobal, lua_gettop, lua_settop, lua_type } from '../generated/lapi.js';

/** sizeof(LG) — the single block lua_newstate() allocates. lstate.js:346. */
const LG_SIZE = 1624n;
/** LUA_EXTRASPACE: the lua_State sits this far into the block. lstate.js:349. */
const L_OFFSET = 8;
/** offsetof(LG, g). lstate.js:350. */
const G_OFFSET = 208;
/** offsetof(global_State, mainthread) — set to L and never changed. lstate.js:362. */
const G_MAINTHREAD = 264;
/** offsetof(global_State, frealloc) — the allocator function. lstate.js:358. */
const G_FREALLOC = 0;

/** LUA_TTABLE */
const LUA_TTABLE = 5;

/** Most recent fresh allocations of exactly sizeof(LG), newest last. */
const candidates = [];
const MAX_CANDIDATES = 8;

let installed = false;

/**
 * The bridge's own lua_State, which is emphatically not the interpreter's.
 *
 * It is allocated through the same `realloc` and is exactly as long, so it
 * lands in `candidates` like any other — and because bridge.mjs creates it
 * lazily, the very first ported level script in a run creates it *immediately
 * before* its body executes, i.e. it becomes the newest candidate. A port that
 * then asked for the interpreter's state (dat/Arc-loca.lua and dat/minetn-6.lua
 * do, for nhlib's `align`) would be handed the port's own, in which nhlib was
 * deliberately never loaded. Excluding it by identity is exact; the structural
 * check cannot tell the two apart, because both really are lua_States.
 */
let portState = null;

/** Tell the probe which state belongs to the bridge. @param {object} L */
export function markPortState(L) { portState = L; }

/**
 * Start watching the allocator. Idempotent, and a no-op unless a read-back
 * port is actually registered — with the ports off, `realloc` is untouched.
 *
 * Must be called after js/boot/harness.mjs has installed its `realloc` (the
 * registry is imported from there, so that ordering is automatic) and before
 * the first nhl_init(), i.e. before main().
 */
export function installStateProbe() {
    if (installed) return;
    const g = globalThis;
    const inner = g.realloc;
    if (typeof inner !== 'function') throw new Error('lua-port: no realloc to probe');
    installed = true;
    g.realloc = (p, n) => {
        const r = inner(p, n);
        // A fresh block of exactly sizeof(LG) is a candidate lua_State. The
        // guard is two comparisons on a path that is already allocating.
        if (p === null && n === LG_SIZE) {
            candidates.push(r);
            if (candidates.length > MAX_CANDIDATES) candidates.shift();
        }
        return r;
    };
}

/** @returns {boolean} whether the block at `l` really is an LG. */
function looksLikeState(l) {
    if (!l || l.buf === undefined || l.buf.length - l.off < Number(LG_SIZE)) return false;
    const L = cptr.add(l, L_OFFSET);
    const G = cptr.add(l, G_OFFSET);
    return cptr.eq(cptr.ldPtro(G, G_MAINTHREAD), L)
        && typeof cptr.ldPtro(G, G_FREALLOC) === 'function';
}

/**
 * The lua_State most recently created by nhl_init().
 *
 * Callers use this at the fopen/fclose of a script nhl_loadlua() is reading,
 * which is always inside the nhl_init() -> nhl_loadlua() pair that created it,
 * so "most recent" is exactly "the one loading this file".
 *
 * @returns {object|null} the lua_State pointer, or null if none was found
 */
export function interpState() {
    for (let i = candidates.length - 1; i >= 0; i--) {
        if (!looksLikeState(candidates[i])) continue;
        const L = cptr.add(candidates[i], L_OFFSET);
        if (portState && cptr.eq(L, portState)) continue;
        return L;
    }
    return null;
}

/**
 * Confirm a state is the one loading `name`: it must be a live state in which
 * the global the script is about to define does not exist yet. Cheap, and it
 * catches the one failure mode discovery could have — handing back a state
 * that has already been used and closed.
 *
 * @param {object} L
 * @param {string} globalName
 * @returns {boolean}
 */
export function stateIsFresh(L, globalName) {
    const base = lua_gettop(L);
    if (base < 0) return false;
    let ok = false;
    try {
        ok = lua_getglobal(L, cptr.lit(globalName)) !== LUA_TTABLE;
    } finally {
        lua_settop(L, base);
    }
    return ok;
}

/**
 * The state's string-hash seed (global_State.seed, lstate.js:363).
 *
 * luai_makeseed() mixes time() with pointer values, so this differs between
 * two states — and between two runs whose allocation histories differ. It
 * decides where a string key lands in a table's node vector, i.e. lua_next
 * order over a hash part. Reported by the read-back oracle so that an order
 * difference can be attributed to the seed instead of to the data.
 *
 * @param {object} L @returns {number}
 */
export function stateSeed(L) {
    return cptr.ldI32o(cptr.add(L, G_OFFSET - L_OFFSET), 96) >>> 0;
}

/** @returns {number} how many candidate blocks are being tracked (tests). */
export function candidateCount() { return candidates.length; }

/** Forget every candidate (segment teardown / test isolation). */
export function resetStateProbe() { candidates.length = 0; portState = null; }

export { LUA_TTABLE };
