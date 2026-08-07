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
import { Longjmp } from '../cjmp.js';
import { luaL_newstate, luaL_ref, luaL_unref } from '../generated/lauxlib.js';
import {
    lua_arith, lua_callk, lua_checkstack, lua_createtable, lua_getfield,
    lua_getglobal, lua_gettop, lua_pcallk, lua_pushboolean, lua_pushcclosure,
    lua_pushinteger, lua_pushnil, lua_pushnumber, lua_pushstring, lua_rawgeti,
    lua_rawseti, lua_setfield, lua_setglobal, lua_settop, lua_toboolean,
    lua_tointegerx, lua_tolstring, lua_tonumberx, lua_type,
} from '../generated/lapi.js';
import { l_register_des } from '../generated/sp_lev.js';
import { l_selection_register } from '../generated/nhlsel.js';
import { l_obj_register } from '../generated/nhlobj.js';
import { rn2 } from '../generated/rnd.js';
import { cmd_from_ecname } from '../generated/cmd.js';
import { depth } from '../generated/dungeon.js';
import { name_to_mon } from '../generated/mondata.js';
import { gu, svm, u } from '../generated/decl.js';
import { interpState, markPortState } from './interp-state.mjs';
import { luaLen, luaList, makeNhlib } from './nhlib.mjs';
import hellTweaksFn from './nhlib-fns.mjs';

/** lua_type() tags. LUA_TNONE is -1. */
const LUA_TNIL = 0;
const LUA_TBOOLEAN = 1;
const LUA_TNUMBER = 3;
const LUA_TSTRING = 4;
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
        // This state is sizeof(LG) bytes out of the same allocator the
        // interpreter's states come from, so interp-state.mjs's probe would
        // otherwise mistake it for one. See markPortState().
        markPortState(L);
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
 *
 * `Lp` selects the state. Level-script ports leave it out and get the
 * port-owned one; the read-back ports (dungeon.lua, quest.lua) pass the
 * interpreter's, because their table has to be visible to a later
 * lua_getglobal() from C. See pushValue() / setGlobal() below.
 */
function push(v, Lp = state()) {
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
        for (let i = 0; i < v.length; i++) { push(v[i], Lp); lua_rawseti(Lp, -2, BigInt(i + 1)); }
        return;
    }
    if (typeof v === 'object') {
        const keys = Object.keys(v);
        lua_createtable(Lp, 0, keys.length);
        for (const k of keys) { push(v[k], Lp); lua_setfield(Lp, -2, cstr(k)); }
        return;
    }
    throw new Error(`lua-port: cannot marshal ${typeof v}`);
}

/** push(), for callers outside this module. @param {object} Lp @param {*} v */
export function pushValue(Lp, v) { push(v, Lp); }

/**
 * `<name> = <value>` in the globals of state `Lp` — the whole of what a
 * pure-data script such as dungeon.lua or quest.lua does.
 *
 * This is the read-back port's counterpart to callTable(): the same
 * lua_createtable / lua_setfield / lua_rawseti sequence the VM's OP_NEWTABLE /
 * OP_SETFIELD / OP_SETLIST would have emitted for the file's one table
 * constructor, followed by the OP_SETTABUP that assigns it to the global.
 *
 * The size hints matter here in a way they did not for the des DSL. C walks
 * the `dungeon` global with lua_next (dungeon.c:1278), and lua_next visits the
 * array part in ascending index order before the hash part — so the port's
 * table must put the same entries in the array part that the parser's would.
 * Passing narr = array length / nrec = key count to lua_createtable is exactly
 * what luaK_settablesize() encodes into OP_NEWTABLE, so the layouts agree by
 * construction rather than by luck.
 *
 * @param {object} Lp   the lua_State to define the global in
 * @param {string} name the global's name
 * @param {*} value     JS value; objects/arrays become Lua tables
 */
export function setGlobal(Lp, name, value) {
    const base = lua_gettop(Lp);
    // Nesting is shallow (quest.lua is 4 deep, dungeon.lua 3) but the C stack
    // must have room for the whole chain plus the value being set.
    if (!lua_checkstack(Lp, 16)) throw new Error('lua-port: lua_checkstack failed');
    try {
        push(value, Lp);
        lua_setglobal(Lp, cstr(name));
    } finally {
        lua_settop(Lp, base);
    }
}

/**
 * A value that lives on the Lua side — the selection or obj userdata a binding
 * handed back. Held by a registry reference (luaL_ref), not a stack index: a
 * `contents` callback runs in its own C call frame, so a stack slot taken in
 * the outer script body would be unaddressable inside it. `LUA_REGISTRYINDEX`
 * is -1001000 in Lua 5.4.
 */
const LUA_REGISTRYINDEX = -1001000;

export class LuaValue {
    /** Takes the value at the top of the stack and pops it. */
    constructor() { this.ref = luaL_ref(state(), LUA_REGISTRYINDEX); }
    push() { lua_rawgeti(state(), LUA_REGISTRYINDEX, BigInt(this.ref)); }
    /** Release the reference so the value can be collected. */
    free() { luaL_unref(state(), LUA_REGISTRYINDEX, this.ref); this.ref = -1; }
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
        const argc = lua_gettop(Lp);
        // Two shapes of callback exist. lspo_room()/lspo_map() push the mkroom
        // table as argument 1 before calling `contents`; l_selection_iterate()
        // pushes two integers, the point it is visiting. Dispatch on what is
        // actually on the stack rather than on the JS arity, because a port
        // may legitimately ignore either.
        if (argc >= 2 && lua_type(Lp, 1) === LUA_TNUMBER) {
            fn(Number(lua_tointegerx(Lp, 1, null)), Number(lua_tointegerx(Lp, 2, null)));
            return 0;
        }
        const room = fn.length >= 1 && argc >= 1 && lua_type(Lp, 1) === LUA_TTABLE
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

/** Same, but keeps the one result. @see takeResult */
function callTable1(tbl, name, args) {
    const Lp = state();
    const base = lua_gettop(Lp);
    lua_getglobal(Lp, cstr(tbl));
    lua_getfield(Lp, -1, cstr(name));
    for (const a of args) push(a);
    lua_callk(Lp, args.length, 1, 0n, null);
    const v = takeResult(Lp);
    lua_settop(Lp, base);       // drop the table
    return v;
}

/**
 * Turn the value on top of the stack into the JS value a Lua script would have
 * been handed, and pop it.
 *
 * Most `selection.*` calls return the selection userdata, which has no JS
 * meaning and is kept as an opaque registry reference (LuaValue) so it can be
 * pushed back later. Four of them do not:
 *
 *   numpoints()  -> an integer, and hell_tweaks() does arithmetic on it
 *   get()        -> an integer
 *   rndcoord()   -> a *fresh* table {x=…, y=…} (nhlsel.c:l_selection_rndcoord
 *                   builds it with lua_newtable + two int entries)
 *   describe_size() -> a string
 *
 * A script that reads `a.x` off rndcoord's result needs a real JS object, and
 * one that passes the whole thing back as `coord = a` needs it re-marshalled —
 * which is exact here, because the table is freshly built, nothing else holds
 * it, and every C reader takes `x` and `y` by name or by index.
 */
function takeResult(Lp) {
    const t = lua_type(Lp, -1);
    if (t === LUA_TNUMBER) {
        const n = lua_tointegerx(Lp, -1, null);
        const v = n === null || n === undefined
            ? lua_tonumberx(Lp, -1, null) : Number(n);
        lua_settop(Lp, lua_gettop(Lp) - 1);
        return v;
    }
    if (t === LUA_TBOOLEAN) {
        const v = lua_toboolean(Lp, -1) !== 0;
        lua_settop(Lp, lua_gettop(Lp) - 1);
        return v;
    }
    if (t === LUA_TSTRING) {
        const v = cptr.cstr(lua_tolstring(Lp, -1, null));
        lua_settop(Lp, lua_gettop(Lp) - 1);
        return v;
    }
    if (t === LUA_TNIL) { lua_settop(Lp, lua_gettop(Lp) - 1); return null; }
    if (t === LUA_TTABLE) {
        const v = readNumTable(Lp, -1);
        lua_settop(Lp, lua_gettop(Lp) - 1);
        return v;
    }
    return new LuaValue();      // userdata: pops into the registry
}

/**
 * The integer fields of a table a selection method built.
 *
 * There are exactly two such tables and between them six field names:
 * `rndcoord()` returns {x, y} and `bounds()` returns {lx, ly, hx, hy}. Reading
 * by name rather than walking with lua_next is deliberate — it is what every
 * C consumer of these tables does too (sp_lev.c's get_coord() reads "x" then
 * "y"), so the port never depends on a hash order.
 *
 * `idx` is a stack index of the table itself; it stays valid across the loop
 * because each lua_getfield's result is popped before the next one.
 */
function readNumTable(Lp, idx) {
    const out = {};
    for (const k of ['x', 'y', 'lx', 'ly', 'hx', 'hy']) {
        lua_getfield(Lp, idx, cstr(k));
        const n = lua_type(Lp, -1) === LUA_TNUMBER ? Number(lua_tointegerx(Lp, -1, null)) : undefined;
        lua_settop(Lp, lua_gettop(Lp) - 1);
        if (n !== undefined) out[k] = n;
    }
    return out;
}

/**
 * `a | b` and `a & b` on two selections.
 *
 * These are not operators the VM evaluates itself. A selection is userdata, so
 * OP_BOR's fast path (`tointegerns` on both operands) fails and the VM falls
 * through to `luaT_trybinTM(L, v1, v2, ra, TM_BOR)`, which finds `__bor` in the
 * selection metatable (nhlsel.c:1009) and calls `l_selection_or`. `l_selection_or`
 * itself is static, so the port cannot call it directly — and should not want
 * to, because the point is to make the same dispatch happen.
 *
 * `lua_arith(L, LUA_OPBOR)` is that dispatch: lua_arith -> luaO_arith ->
 * luaO_rawarith (which fails on userdata for exactly the same reason) ->
 * luaT_trybinTM(..., TM_ADD + (LUA_OPBOR - LUA_OPADD)) = TM_BOR. Same
 * metamethod, same two arguments, same result slot. The only difference from
 * OP_BOR is that the result lands on the stack top instead of in a register,
 * and both are stack slots.
 *
 * @param {number} op LUA_OPBAND (7) or LUA_OPBOR (8), lua.h's ORDER TM
 */
function selectionArith(op, a, b) {
    const Lp = state();
    const base = lua_gettop(Lp);
    push(a);
    push(b);
    lua_arith(Lp, op);
    const v = takeResult(Lp);
    lua_settop(Lp, base);
    return v;
}

/** lua.h's arithmetic opcodes (ORDER TM, ORDER OP). */
const LUA_OPADD = 0;
const LUA_OPSUB = 1;
const LUA_OPBAND = 7;
const LUA_OPBOR = 8;

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

/**
 * The two `des.*` bindings that push a result: lspo_map() returns a selection
 * of the squares it wrote, lspo_object() returns the obj it made. Every other
 * one returns 0.
 *
 * Only lspo_map()'s result is ever read in the 131-file corpus, and only by
 * the Gehennom group — `local asmo1 = des.map{…}`, seven more like it — which
 * then unions the three regions into hell_tweaks()'s protected area. (The two
 * scripts that read `des.object`'s result are themerms.lua and hellfill.lua,
 * i.e. S7's; this list is where that will be turned on.)
 *
 * Asking lua_callk for one result where the .lua asked for none is not
 * observable: luaD_poscall's moveresults() only pads or trims the *port's own*
 * stack, and the C function has already done all its work by then. Keeping the
 * list to `map` is about not minting a registry reference per des.object()
 * call — there are 1,420 of those — rather than about correctness.
 */
const DES_VALUE_FUNCS = new Set(['map']);

/** des.* — a call discards its results, as a Lua statement does. */
export const des = Object.freeze(Object.fromEntries(
    DES_FUNCS.map((n) => [n, DES_VALUE_FUNCS.has(n)
        ? (...args) => callTable1('des', n, args)
        : (...args) => callTable('des', n, args)]),
));

/**
 * selection.* — every call yields a value, so results are kept.
 *
 * The last four are not entries in nhlsel.c's method table. They are the four
 * *operators* a script can write between two selections, named for the
 * metamethod each dispatches to, because JS has no operator overloading:
 *
 *   a | b  ->  __bor  -> l_selection_or     selection.bor(a, b)
 *   a & b  ->  __band -> l_selection_and    selection.band(a, b)
 *   a + b  ->  __add  -> l_selection_or     selection.add(a, b)
 *   a - b  ->  __sub  -> l_selection_sub    selection.sub(a, b)
 *
 * `+` and `|` really are the same C function — nhlsel.c says so in a comment —
 * but they are kept apart here so the port issues the dispatch the .lua wrote.
 */
export const selection = Object.freeze(Object.fromEntries([
    ...SELECTION_FUNCS.map((n) => [n, (...args) => callTable1('selection', n, args)]),
    ['bor', (a, b) => selectionArith(LUA_OPBOR, a, b)],
    ['band', (a, b) => selectionArith(LUA_OPBAND, a, b)],
    ['add', (a, b) => selectionArith(LUA_OPADD, a, b)],
    ['sub', (a, b) => selectionArith(LUA_OPSUB, a, b)],
]));

// ---------------------------------------------------------------------------
// nhlib.lua's helpers, ported (RNG-exact)
// ---------------------------------------------------------------------------

/** nh.rn2(n) — nhl_rn2() is a straight call to NetHack's rn2(). */
export function nhRn2(n) { return rn2(n); }

/**
 * nhlib.lua's `math.random` / `shuffle` / `percent` / `d`, built over NetHack's
 * own rn2(). The algorithms live in nhlib.mjs so that the generator's --check
 * can drive the identical code from a deterministic counter — see that file.
 */
export const { nhRandom, mathRandom, percent, d, shuffle } = makeNhlib(rn2);

// ---------------------------------------------------------------------------
// The rest of the prelude a level script can see
// ---------------------------------------------------------------------------

/**
 * `nh.eckey(cmd)` — nhl_get_cmd_key() (nhlua.c:1798), which is a bare
 * cmd_from_ecname() and a lua_pushstring of the result. dat/tut-2.lua
 * concatenates it into an engraving, so the bytes have to be identical; taking
 * them from the same C function is how that is guaranteed.
 */
export function eckey(cmd) {
    const p = cmd_from_ecname(cstr(cmd));
    if (!p) throw new Error(`lua-port: nh.eckey(${cmd}) has no key binding`);
    return cptr.cstr(p);
}

/**
 * nhlib.lua's `align`, read out of the interpreter's own lua_State.
 *
 * This one cannot be recomputed. `align = { "law", "neutral", "chaos" }`
 * followed by `shuffle(align)` runs at the top of nhlib.lua, i.e. inside the
 * nhl_init() that built the state now loading this script, and it spends two
 * rn2() draws doing it (§3(b)). Those draws have already happened and their
 * result lives only in that state, so a port that wants `align[1]` has to go
 * and read it — reproducing the shuffle in JS would need two more draws and
 * desynchronise the RNG immediately.
 *
 * @returns {(string|undefined)[]} 1-based, so `align[1]` means what it means
 *   in the .lua; index 0 is unused.
 */
export function interpAlign() {
    const L = interpState();
    if (!L) throw new Error('lua-port: interpreter lua_State not found (align)');
    const base = lua_gettop(L);
    try {
        if (lua_getglobal(L, cstr('align')) !== LUA_TTABLE) {
            throw new Error("lua-port: nhlib's `align` global is not a table");
        }
        const out = [undefined];
        for (let i = 1; i <= 3; i++) {
            lua_rawgeti(L, -1, BigInt(i));
            const s = lua_tolstring(L, -1, null);
            if (!s) throw new Error(`lua-port: align[${i}] is not a string`);
            out.push(cptr.cstr(s));
            lua_settop(L, lua_gettop(L) - 1);
        }
        return out;
    } finally {
        lua_settop(L, base);
    }
}

/**
 * nhlib.lua:47 `monkfoodshop()` — the one nhlib helper a T0 script calls.
 * `u.role` is nhl_u_index()'s "role" case, i.e. gu.urole.name.m
 * (js/generated/nhlua.js:2046). No RNG, no Lua state.
 */
export function monkfoodshop() {
    return cptr.cstr(cptr.ldPtro(gu, 8)) === 'Monk' ? 'health food shop' : 'food shop';
}

/**
 * `nh.is_genocided(name)` — nhl_is_genocided(), transcribed the way
 * monkfoodshop() is: name_to_mon() and then the G_GENOD bit of that species'
 * svm.mvitals[] entry. dat/tower1.lua asks before naming Dracula's three
 * brides, so a game that genocided vampires gets them nameless.
 *
 * `cptr.ld1uo2(svm, i, 12, 18)` is js/generated/nhlua.js's own expression for
 * `svm.mvitals[i].mvflags`: element stride 12, field offset 18, one unsigned
 * byte. No RNG, no Lua state — the same shape of read as levelFingerprint()'s.
 */
const G_GENOD = 0x02;
const NON_PM = -1;
export function isGenocided(name) {
    const i = name_to_mon(cstr(name), cptr.box(0));
    return i !== NON_PM && (cptr.ld1uo2(svm, i, 12, 18) & G_GENOD) !== 0;
}

/**
 * The `u` table, as far as anything this port replaces reads it.
 *
 * Only `depth` is needed, and only by hell_tweaks(), which spends
 * `percent(20 + u.depth)` and `math.random(u.depth)` on it. nhl_meta_u_index()'s
 * "depth" case is `lua_pushinteger(L, depth(&u.uz))` (nhlua.c:2171), and `&u.uz`
 * is `cptr.add(u, 24)` in the transpiler's own output (nhlua.js:2055). A getter,
 * so a port that never mentions `u` never reads NetHack's memory for it.
 */
export const uTable = Object.freeze({
    get depth() { return depth(cptr.add(u, 24)); },
});

/**
 * `nhc` — nhl_consts[] (nhlua.c:2060), the compile-time constants nhlua.c
 * publishes to Lua. hell_tweaks() reads COLNO and ROWNO to size its lava
 * river; nothing else a port replaces reads any of the other five.
 */
export const nhc = Object.freeze({ COLNO: 80, ROWNO: 21 });

// `luaList` / `luaLen` — Lua's 1-based lists and its `#` operator. Defined in
// nhlib.mjs because shuffle() has to know where element 1 lives; re-exported
// here so a port only ever imports the bridge.
export { luaLen, luaList };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The API object handed to every ported script.
 *
 * `align` is a getter because it reads the interpreter's state: evaluating it
 * eagerly would make every port depend on a state discovery that only the two
 * scripts using `align` actually need. Destructuring `{ des }` never touches it.
 *
 * `hell_tweaks` is nhlib.lua's, ported to js/lua-js/nhlib-fns.mjs by the same
 * generator that emits the level scripts and handed this same api object — so
 * the seven Gehennom levels that end with it are ports all the way down.
 */
export const api = Object.freeze({
    des, selection,
    nh: Object.freeze({ rn2: nhRn2, random: nhRandom, eckey, is_genocided: isGenocided }),
    // `math` is nhlib.lua's shim, not JavaScript's: a port writes
    // `math.random(4, 8)` exactly as the .lua does and draws from NetHack's RNG.
    percent, shuffle, d, math: Object.freeze({ random: mathRandom }),
    get align() { return interpAlign(); },
    monkfoodshop,
    hell_tweaks: (protectedArea) => hellTweaksFn(api, protectedArea),
    u: uTable, nhc, luaList, luaLen,
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
    runProtected(state(), name, () => body(api));
}

/**
 * Run `body` inside a lua_pcallk on state `Lp`, the way nhl_loadlua() runs a
 * chunk inside nhl_pcall_handle().
 *
 * Two things need the protection. A luaL_error() raised by a C binding
 * longjmps, and in this transpile a longjmp is a JS exception thrown through
 * whatever frames are in between — it has to be caught by a Lua frame, not by
 * the harness. And the sandbox nhl_init() installs is memory-limited
 * (nhl_alloc returns NULL past nud->memlimit), so an over-large marshalling
 * raises LUA_ERRMEM rather than corrupting anything. A JS-level throw is
 * stashed and re-thrown once the Lua stack has been unwound.
 *
 * @param {object} Lp
 * @param {string} name  for the error message
 * @param {() => void} body
 */
export function runProtected(Lp, name, body) {
    const base = lua_gettop(Lp);
    let thrown = null;
    lua_pushcclosure(Lp, () => {
        try {
            body();
        } catch (e) {
            // A Lua error is a longjmp, and in this transpile a longjmp is a JS
            // throw of cjmp.Longjmp. That one has to keep going: lua_pcallk's
            // own handler is what catches it, unwinds the Lua stack and leaves
            // the message on top, which is how a bad argument to an lspo_*
            // becomes a readable "lua-port <script>: …" instead of an opaque
            // object. Only a *JS*-level throw is stashed for re-throw below.
            if (e instanceof Longjmp) throw e;
            thrown = e;
        }
        return 0;
    }, 0);
    const rc = lua_pcallk(Lp, 0, 0, 0, 0n, null);
    if (thrown) { lua_settop(Lp, base); throw thrown; }
    if (rc !== 0) {
        const msg = cptr.cstr(lua_tolstring(Lp, -1, null));
        lua_settop(Lp, base);
        throw new Error(`lua-port ${name}: ${msg}`);
    }
    lua_settop(Lp, base);
}
