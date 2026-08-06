// bridge.mjs — run a hand-ported NetHack level script as readable JavaScript.
//
// WHAT THIS IS. NetHack's special levels, dungeon layout, quest text and themed
// rooms ship as ~131 .lua scripts that the game executes through a *transpiled*
// Lua 5.4.8 interpreter (js/generated/l*.js). Roadmap 1.10 ports those scripts
// to readable JS. This module is the seam that lets a ported script take the
// interpreter's place without changing one byte of observable behaviour.
//
// THE KEY OBSERVATION. A level script never touches Lua's own state in any way
// the game can see. Everything it does flows through C functions registered
// into the Lua state — des.*, selection.*, obj.*, nh.* — and every one of those
// reads its arguments off the Lua stack and then mutates NetHack's C globals
// (the level map, the object/monster chains, the RNG). The lua_State is a
// *marshalling buffer*, nothing more.
//
// So a ported script does not need Lua source, a parser, or a VM. It needs to
// (1) build the same argument values the VM would have built, and (2) invoke
// the same registered C functions in the same order. We do that by driving the
// transpiled Lua C API directly: lua_createtable / lua_pushstring / lua_setfield
// / lua_callk, exactly the calls the VM's OP_NEWTABLE / OP_SETFIELD / OP_CALL
// would have made. The lspo_* implementations are the real, unmodified,
// transpiled C — they cannot tell the difference, because there isn't one.
//
// WHY OUR OWN lua_State. The state that nhl_loadlua() is holding is a local
// variable buried in transpiled C; ES module bindings are immutable, so there
// is no way to reach it from harness JS without hand-editing js/generated
// (forbidden) or an emitter hook (out of scope). We don't need it: we make our
// own with luaL_newstate() and register the same three tables (des, selection,
// obj). The C bindings key off NetHack's globals, not off which state called
// them, so a port-owned state produces identical effects. It is created once
// per module graph (i.e. once per replay segment) and reused by every port.
//
// DETERMINISM NOTES (the traps, and why they don't bite here):
//   * Table traversal order. Nothing in sp_lev.c walks a script-supplied table
//     with lua_next; every field is read by name with lua_getfield, in an order
//     hard-coded in the C function body. Field order in a table constructor is
//     therefore unobservable — but we preserve JS object key order anyway so
//     the internal hash layout matches too.
//   * RNG order. All script-visible randomness is NetHack's rn2(); nhlib.lua's
//     math.random shim is 1 + nh.rn2(n) / base + nh.rn2(range). See rn2/random/
//     percent/shuffle/d below, which reproduce those *exactly*, and the fact
//     that a des.* call consumes its RNG inside C means call order is the only
//     thing a port has to get right.
//   * Callbacks. `contents = function() ... end` becomes a JS closure pushed
//     with lua_pushcclosure(); lspo_room() calls it through nhl_pcall_handle()
//     the same way it calls a Lua closure (lua_type() reports LUA_TFUNCTION for
//     both), so the recursion into the script body happens at the same point.
//   * Errors. The port body runs inside lua_pcallk(), mirroring the pcall that
//     nhl_loadlua() wraps the chunk in.

import * as cptr from '../cptr.js';
import { luaL_newstate } from '../generated/lauxlib.js';
import {
    lua_callk, lua_createtable, lua_getfield, lua_getglobal, lua_gettop,
    lua_pcallk, lua_pushboolean, lua_pushcclosure, lua_pushinteger, lua_pushnil,
    lua_pushnumber, lua_pushstring, lua_pushvalue, lua_rawseti, lua_setfield,
    lua_settop, lua_tointegerx, lua_tolstring, lua_type,
} from '../generated/lapi.js';
import { l_register_des } from '../generated/sp_lev.js';
import { l_selection_register } from '../generated/nhlsel.js';
import { l_obj_register } from '../generated/nhlobj.js';
import { rn2 } from '../generated/rnd.js';

/** lua_type() tag for tables — LUA_TTABLE. */
const LUA_TTABLE = 5;

// C strings are allocated per call by cptr.lit(); intern them so a script that
// pushes "monster" 2000 times doesn't build 2000 identical byte arrays.
const cstrCache = new Map();
function cstr(s) {
    let p = cstrCache.get(s);
    if (p === undefined) { p = cptr.lit(s); cstrCache.set(s, p); }
    return p;
}

// ---------------------------------------------------------------------------
// The port-owned lua_State
// ---------------------------------------------------------------------------

let L = null;

/**
 * The state used to marshal arguments into the transpiled C bindings.
 *
 * Deliberately NOT nhl_init(): that also loads nhlib.lua, whose top-level
 * `shuffle(align)` consumes two rn2() draws. Those draws belong to the
 * interpreter's per-script nhl_init() call, which still happens exactly as
 * before — this state must not duplicate them. We register only the three
 * tables the des DSL needs; none of the lspo_* functions read a Lua global.
 *
 * @returns {object} the lua_State pointer
 */
function state() {
    if (L === null) {
        L = luaL_newstate();
        if (!L) throw new Error('lua-port: luaL_newstate() failed');
        l_selection_register(L);
        l_register_des(L);
        l_obj_register(L);
    }
    return L;
}

/** Drop the port state (segment teardown / test isolation). */
export function resetBridge() { L = null; }

// ---------------------------------------------------------------------------
// JS value -> Lua stack
// ---------------------------------------------------------------------------

/**
 * Push one JS value as the Lua value a table constructor would have produced.
 *
 * number  -> lua_pushinteger when integral (NetHack's des DSL is integer-only;
 *            luaL_checkinteger rejects non-integral floats), else pushnumber
 * string  -> lua_pushstring (interned in the state's string table, as OP_LOADK
 *            constants are)
 * boolean -> lua_pushboolean
 * array   -> table with an array part, filled by lua_rawseti like OP_SETLIST
 * object  -> table with a hash part, filled by lua_setfield like OP_SETFIELD,
 *            in JS key-insertion order = Lua source order
 * function-> lua_pushcclosure over a JS callback (see wrapCallback)
 * null    -> lua_pushnil
 */
function push(v) {
    const Lp = state();
    if (v === null || v === undefined) { lua_pushnil(Lp); return; }
    switch (typeof v) {
        case 'boolean': lua_pushboolean(Lp, v ? 1 : 0); return;
        case 'number':
            if (Number.isInteger(v)) lua_pushinteger(Lp, BigInt(v));
            else lua_pushnumber(Lp, v);
            return;
        case 'bigint': lua_pushinteger(Lp, v); return;
        case 'string': lua_pushstring(Lp, cstr(v)); return;
        case 'function': lua_pushcclosure(Lp, wrapCallback(v), 0); return;
        default: break;
    }
    if (v instanceof LuaValue) { v.push(); return; }
    if (Array.isArray(v)) {
        // OP_NEWTABLE's size hints come from the constructor's shape; match them.
        lua_createtable(Lp, v.length, 0);
        for (let i = 0; i < v.length; i++) { push(v[i]); lua_rawseti(Lp, -2, BigInt(i + 1)); }
        return;
    }
    if (typeof v === 'object') {
        const keys = Object.keys(v);
        lua_createtable(Lp, 0, keys.length);
        for (const k of keys) { push(v[k]); lua_setfield(Lp, -2, cstr(k)); }
        return;
    }
    throw new Error(`lua-port: cannot marshal ${typeof v}`);
}

/**
 * A value that lives on the Lua side (a selection / obj userdata handed back by
 * a binding). Kept as an absolute stack index inside the current port frame:
 * the port body runs as one C call, so the frame is stable for its lifetime.
 */
export class LuaValue {
    constructor(index) { this.index = index; }
    push() { lua_pushvalue(state(), this.index); }
}

/**
 * Wrap a JS closure so the transpiled VM can call it as a lua_CFunction.
 *
 * lua_pushcclosure() stores the function pointer verbatim and luaD_precall()
 * invokes it as `n = (f)(L)` — and in this transpile a C function pointer *is*
 * a JS function object, so a JS closure is a valid lua_CFunction with no
 * thunking at all. lspo_room() pushes the mkroom table as argument 1 before
 * calling; we only materialise it when the port's callback asks for it.
 */
function wrapCallback(fn) {
    return (Lp) => {
        const room = fn.length >= 1 && lua_gettop(Lp) >= 1 && lua_type(Lp, 1) === LUA_TTABLE
            ? readIntTable(Lp, 1) : undefined;
        fn(room);
        return 0;
    };
}

/** Read the integer fields of a table (the mkroom table lspo_room passes). */
function readIntTable(Lp, idx) {
    const out = {};
    for (const k of ['x', 'y', 'w', 'h', 'lit', 'rlit', 'nsubrooms', 'needjoining', 'irregular']) {
        lua_getfield(Lp, idx, cstr(k));
        const n = lua_tointegerx(Lp, -1, null);
        lua_settop(Lp, lua_gettop(Lp) - 1);
        if (n !== null && n !== undefined) out[k] = Number(n);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Calling into the registered C bindings
// ---------------------------------------------------------------------------

/**
 * `tbl.name(...args)` — the exact sequence the VM emits for a global call:
 * GETTABUP _ENV "tbl"; GETFIELD "name"; push args; CALL nargs 1.
 */
function callTable(tbl, name, args) {
    const Lp = state();
    const base = lua_gettop(Lp);
    lua_getglobal(Lp, cstr(tbl));
    lua_getfield(Lp, -1, cstr(name));
    for (const a of args) push(a);
    lua_callk(Lp, args.length, 0, 0n, null);
    lua_settop(Lp, base);
}

/** Same, but keeps one result and returns it as a LuaValue handle. */
function callTable1(tbl, name, args) {
    const Lp = state();
    const base = lua_gettop(Lp);
    lua_getglobal(Lp, cstr(tbl));
    lua_getfield(Lp, -1, cstr(name));
    for (const a of args) push(a);
    lua_callk(Lp, args.length, 1, 0n, null);
    // stack: base+1 = tbl, base+2 = result -> compact to base+1
    lua_pushvalue(Lp, -1);
    lua_settop(Lp, base + 1);
    return new LuaValue(base + 1);
}

// The 34 entries of sp_lev.c's nhl_functions[], i.e. the whole des DSL.
const DES_FUNCS = [
    'message', 'monster', 'object', 'level_flags', 'level_init', 'engraving',
    'mineralize', 'door', 'stair', 'ladder', 'grave', 'altar', 'map', 'feature',
    'terrain', 'replace_terrain', 'room', 'corridor', 'random_corridors', 'gold',
    'trap', 'mazewalk', 'drawbridge', 'region', 'levregion', 'exclusion',
    'wallify', 'wall_property', 'non_diggable', 'non_passwall',
    'teleport_region', 'reset_level', 'finalize_level', 'gas_cloud',
];

// nhlsel.c's l_selection_methods[].
const SELECTION_FUNCS = [
    'new', 'clone', 'get', 'set', 'numpoints', 'negate', 'percentage',
    'rndcoord', 'line', 'randline', 'rect', 'fillrect', 'area', 'grow',
    'filter_mapchar', 'match', 'floodfill', 'circle', 'ellipse', 'gradient',
    'iterate', 'bounds', 'room', 'describe_size',
];

/** des.* — every call discards its results, as a Lua statement does. */
export const des = Object.freeze(Object.fromEntries(
    DES_FUNCS.map((n) => [n, (...args) => callTable('des', n, args)]),
));

/** selection.* — every call yields a value, so results are kept. */
export const selection = Object.freeze(Object.fromEntries(
    SELECTION_FUNCS.map((n) => [n, (...args) => callTable1('selection', n, args)]),
));

// ---------------------------------------------------------------------------
// nhlib.lua's helpers, ported (RNG-exact)
// ---------------------------------------------------------------------------

/** nh.rn2(n) — nhl_rn2() is a straight call to NetHack's rn2(). */
export function nhRn2(n) { return rn2(n); }

/** nh.random(base, range) / nh.random(range) — nhl_random(). */
export function nhRandom(a, b) { return b === undefined ? rn2(a) : (a + rn2(b)) | 0; }

/**
 * nhlib.lua's math.random shim:
 *   1 arg  -> 1 + nh.rn2(n)
 *   2 args -> nh.random(lo, hi + 1 - lo)
 */
export function mathRandom(a, b) {
    return b === undefined ? 1 + rn2(a) : nhRandom(a, (b + 1 - a) | 0);
}

/** nhlib.lua: percent(t) = math.random(0, 99) < t, i.e. rn2(100) < t. */
export function percent(t) { return mathRandom(0, 99) < t; }

/** nhlib.lua: d(dice, faces); one-arg form is 1dN. */
export function d(dice, faces) {
    if (faces === undefined) return mathRandom(1, dice);
    let sum = 0;
    for (let i = 0; i < dice; i++) sum += mathRandom(1, faces);
    return sum;
}

/**
 * nhlib.lua's shuffle(): descending Fisher-Yates over a 1-based Lua list.
 * `list` here is a 0-based JS array; the draw sequence is identical because it
 * depends only on the length, not the indexing convention.
 */
export function shuffle(list) {
    for (let i = list.length; i >= 2; i--) {
        const j = mathRandom(i);
        const t = list[i - 1]; list[i - 1] = list[j - 1]; list[j - 1] = t;
    }
    return list;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The API object handed to every ported script. */
export const api = Object.freeze({
    des, selection,
    nh: Object.freeze({ rn2: nhRn2, random: nhRandom }),
    percent, shuffle, d, mathRandom,
});

/**
 * Execute a ported script in place of its .lua source.
 *
 * Called from the VFS layer at the moment nhl_loadlua() finishes reading the
 * file — i.e. after nhl_init() has built the interpreter's state (and consumed
 * nhlib.lua's two align-shuffle draws) and before the stub chunk is compiled.
 * The body runs inside lua_pcallk(), mirroring nhl_loadlua()'s own pcall.
 *
 * @param {string} name  script filename, e.g. "oracle.lua"
 * @param {(api: object) => void} body  the ported script
 */
export function runPortedScript(name, body) {
    const Lp = state();
    const base = lua_gettop(Lp);
    let thrown = null;
    lua_pushcclosure(Lp, () => { try { body(api); } catch (e) { thrown = e; } return 0; }, 0);
    const rc = lua_pcallk(Lp, 0, 0, 0, 0n, null);
    if (thrown) { lua_settop(Lp, base); throw thrown; }
    if (rc !== 0) {
        const msg = cptr.cstr(lua_tolstring(Lp, -1, null));
        lua_settop(Lp, base);
        throw new Error(`lua-port ${name}: ${msg}`);
    }
    lua_settop(Lp, base);
}
