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
import { luaL_newstate, luaL_ref, luaL_requiref, luaL_unref } from '../generated/lauxlib.js';
import { luaopen_string } from '../generated/lstrlib.js';
import {
    lua_arith, lua_callk, lua_checkstack, lua_createtable, lua_getfield,
    lua_getglobal, lua_gettop, lua_len, lua_next, lua_pcallk, lua_pushboolean,
    lua_pushcclosure, lua_pushinteger, lua_pushnil, lua_pushnumber,
    lua_pushstring, lua_pushvalue, lua_rawgeti, lua_rawseti, lua_rotate, lua_setfield,
    lua_setglobal, lua_settop, lua_toboolean, lua_tointegerx, lua_tolstring,
    lua_tonumberx, lua_type,
} from '../generated/lapi.js';
import { l_register_des } from '../generated/sp_lev.js';
import { l_selection_register } from '../generated/nhlsel.js';
import { l_obj_register } from '../generated/nhlobj.js';
import { rn2 } from '../generated/rnd.js';
import { cmd_from_ecname } from '../generated/cmd.js';
import { Invocation_lev, depth, level_difficulty } from '../generated/dungeon.js';
import { name_to_mon } from '../generated/mondata.js';
import { parse_conf_str, parse_config_line } from '../generated/cfgfiles.js';
import { gu, svm, u } from '../generated/decl.js';
import { interpState, markPortState } from './interp-state.mjs';
import {
    LuaList, jsPairs, jsSetIndex, jsToString, jsType, libPline, libTableStringify,
    luaLen, luaList, makeNhlib,
} from './nhlib.mjs';
import hellTweaksFn, { monkfoodshop as monkfoodshopFn } from './nhlib-fns.mjs';

/**
 * `lua_toboolean()` as a JS boolean.
 *
 * The C function returns an `int`, but this transpile emits its body as
 * `return !(…)` (js/generated/lapi.js:410), i.e. a JS *boolean*. Comparing that
 * against 0 with `!==` is therefore true for `false` as well as for `true` —
 * which is what made every `rm.lit` the port read come back `true`, and the
 * Garden themeroom fill eligible in unlit rooms. Found by the themeroom probe
 * (§15): the interpreter printed "Warning: fill 'Garden' is not eligible in
 * room that generated it" twice and the port printed it never.
 *
 * Everything that reads a Lua boolean goes through here so the mistake cannot
 * be made twice.
 */
function luaBool(Lp, idx) { return !!lua_toboolean(Lp, idx); }

/** lua_type() tags. LUA_TNONE is -1. */
const LUA_TNIL = 0;
const LUA_TBOOLEAN = 1;
const LUA_TNUMBER = 3;
const LUA_TSTRING = 4;
const LUA_TTABLE = 5;
const LUA_TUSERDATA = 7;

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
 * The state the api is currently driving, or null for "the port's own".
 *
 * S6 needs this. A *level* script's port is the only thing running, so its
 * marshalling can happen in a state of its own (see below). A *library* port —
 * nhlib.lua's `hell_tweaks`, `shuffle`, `tutorial_turn` — is installed into the
 * interpreter's state as a lua_CFunction and is called *by Lua*, with Lua
 * values (a selection userdata, a table) that belong to that state and cannot
 * be moved to another one. So while such a function runs, `state()` answers
 * with the state that called it, and every `des.*` / `selection.*` / `obj.*`
 * the ported body issues is marshalled there instead.
 *
 * It is a cursor rather than a parameter for the same reason the generator's
 * `curScope` is: threading a state through 34 des bindings and 24 selection
 * ones would put it in every ported line, and the ports are the thing a
 * reviewer has to be able to read against the .lua.
 */
let activeL = null;

/**
 * Run `body` with the api bound to state `Lp`. Restores the previous binding,
 * so a library function called from a level-script port (hell_tweaks, from the
 * seven Gehennom ports) keeps using the port's state.
 *
 * @param {object} Lp @param {() => *} body
 */
export function withState(Lp, body) {
    const saved = activeL;
    activeL = Lp;
    try { return body(); } finally { activeL = saved; }
}

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
    if (activeL !== null) return activeL;
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
        // Lua's *string* library, and only it. dat/tut-1.lua is the one script
        // in the corpus that uses a string method — `s:match("^^([A-Z])$")`,
        // twice — and a Lua pattern is not a JS regexp: the two disagree about
        // `%`, about `-`, about character classes and about anchoring. Rather
        // than reimplement `str_match`, the port calls it, through the same
        // `string.match` the VM would have reached via the string metatable's
        // __index. nhl_init() opens this library too (NHL_SB_STRING is part of
        // NHL_SB_SAFE, nhlua.c's nhlL_openlibs), so this is the same code
        // running on the same input.
        //
        // Only `string`. §9's gotcha still stands for the rest: opening `math`
        // would re-seed a PRNG nobody reads, and luaL_openlibs would open both.
        // luaopen_string touches no NetHack global and draws nothing.
        const base = lua_gettop(L);
        luaL_requiref(L, cstr('string'), luaopen_string, 1);
        lua_settop(L, base);
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
        case 'function':
            // A function built by luaFn()/luaRawFn() is *already* a
            // lua_CFunction with its own calling convention; wrapping it again
            // would hand it the mkroom table where it expects a lua_State.
            // Anything else is a port's `contents`/`inventory`/`iterate`
            // closure, which is what wrapCallback exists for.
            lua_pushcclosure(Lp, v.__luaCFunction ? v : wrapCallback(v), 0);
            return;
        default: break;
    }
    if (v instanceof LuaValue) { v.push(); return; }
    if (v instanceof LuaRef) { v.push(Lp); return; }
    // A LuaList is an Array whose slot 0 is a placeholder for Lua's 1-based
    // indexing, so it must not go through the Array branch below: that would
    // push a nil at index 1 and shift every element. themerms.lua's port keeps
    // `themerooms` and `themeroom_fills` as luaList()s and mirrors them into the
    // state, which is where this matters.
    if (v instanceof LuaList) {
        const n = luaLen(v);
        lua_createtable(Lp, n, 0);
        for (let i = 1; i <= n; i++) { push(v[i], Lp); lua_rawseti(Lp, -2, BigInt(i)); }
        return;
    }
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

/**
 * A Lua table named by its *path* from a global, rather than by a registry
 * reference: `nh_lua_variables`, `nh_lua_variables._CB_end_turn`.
 *
 * nhcore.lua's callback tables are reached hundreds of times in a tutorial
 * game — once per turn for `end_turn`, once per extended command for
 * `cmd_before` — and a registry reference per read would grow the registry
 * without bound, because a ported body has no natural place to unref one. A
 * path costs nothing to hold and re-derives the value with the same
 * lua_getglobal + lua_getfield the .lua's own indexing compiles to.
 */
export class LuaRef {
    /** @param {string} root a global name @param {string[]} keys */
    constructor(root, keys = []) { this.root = root; this.keys = keys; }
    /** The table at `this[k]`. */
    child(k) { return new LuaRef(this.root, [...this.keys, k]); }
    push(Lp) {
        lua_getglobal(Lp, cstr(this.root));
        for (const k of this.keys) {
            lua_getfield(Lp, -1, cstr(k));
            // lua_remove(L, -2): the intermediate table was only a step of the
            // path, and only the value it led to belongs on the stack.
            lua_rotate(Lp, -2, 1);
            lua_settop(Lp, lua_gettop(Lp) - 1);
        }
    }
}

export class LuaValue {
    /** Takes the value at the top of the stack and pops it. */
    constructor(ltype) {
        /** lua_type() of the value, so a port can ask what it is holding. */
        this.ltype = ltype ?? lua_type(state(), -1);
        this.ref = luaL_ref(state(), LUA_REGISTRYINDEX);
        this.L = state();
        if (callPool !== null) callPool.push(this);
    }
    push() { lua_rawgeti(state(), LUA_REGISTRYINDEX, BigInt(this.ref)); }
    /** Release the reference so the value can be collected. */
    free() {
        if (this.ref < 0) return;
        luaL_unref(this.L, LUA_REGISTRYINDEX, this.ref);
        this.ref = -1;
    }
}

// ---------------------------------------------------------------------------
// Lifetimes: freeing the registry references a port takes (S7)
// ---------------------------------------------------------------------------
//
// Every selection or obj a binding hands back is held by a luaL_ref, and until
// S7 nothing ever released one. That was harmless for 129 ports because the
// state holding the references dies with the script: a level script's port
// state is the bridge's own (dropped per replay segment) and a library port's
// is the interpreter's throwaway per-level one.
//
// themerms.lua is the exception, and the reason this exists. Its lua_State is
// gl.luathemes[dnum] — created once per dungeon branch, kept across every level
// of that branch, and created by nhl_init() with a **1 MB memory cap**
// (mklev.c:369's nhl_sandbox_info). A `selection.room()` userdata is over a
// kilobyte, so leaking one per themed room would exhaust the sandbox inside one
// game. The interpreter does not leak them: they are Lua locals, they become
// garbage when the room generator returns, and themerooms_post_level_generate()
// ends with lua_gc(themes, LUA_GCCOLLECT).
//
// So the port reproduces those two lifetimes explicitly, and they are exactly
// the .lua's own:
//
//   withCallValues() — a value that dies with the room generator that made it.
//                      Everything minted inside is freed when the C-callable
//                      entry point returns, which is before makerooms()'s next
//                      call and long before the LUA_GCCOLLECT.
//   keepValue()      — a value that escapes into `postprocess`, i.e. survives
//                      until post_level_generate() runs the handler. themerms
//                      has exactly one (the Garden fill's `sel`).
//
// Freeing matters for more than memory. An obj userdata carries
// obj->lua_ref_cnt, which l_obj_gc() decrements; a reference the port never
// released would leave that count high on an object the interpreter's GC had
// already let go.

/** LuaValues minted during the current entry-point call, or null. */
let callPool = null;
/** LuaValues explicitly kept past the call that made them. */
let keptValues = [];

/**
 * Run `body` with a call-scoped pool: every LuaValue taken inside is released
 * when it returns, except those handed to keepValue().
 * @param {() => *} body
 */
export function withCallValues(body) {
    const saved = callPool;
    callPool = [];
    try {
        return body();
    } finally {
        const pool = callPool;
        callPool = saved;
        for (let i = pool.length - 1; i >= 0; i--) pool[i].free();
    }
}

/** Keep `v` past the current call; released by releaseKeptValues(). */
export function keepValue(v) {
    if (callPool !== null) {
        const i = callPool.indexOf(v);
        if (i >= 0) callPool.splice(i, 1);
    }
    keptValues.push(v);
    return v;
}

/** Release everything keepValue() is holding. */
export function releaseKeptValues() {
    for (let i = keptValues.length - 1; i >= 0; i--) keptValues[i].free();
    keptValues = [];
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
        // Three shapes of callback exist, and the port dispatches on what is
        // actually on the stack rather than on the JS arity, because a port may
        // legitimately ignore any of them.
        //
        //   two integers — l_selection_iterate(), the point it is visiting
        //   a table      — lspo_room()/lspo_region() push l_push_mkroom_table(),
        //                  lspo_map() pushes l_push_wid_hei_table()
        //   userdata     — lspo_object() pushes nhl_push_obj(otmp) into the
        //                  container's `contents`, which is what themerms.lua's
        //                  "Buried treasure" reads with otmp:totable()
        if (argc >= 2 && lua_type(Lp, 1) === LUA_TNUMBER) {
            fn(Number(lua_tointegerx(Lp, 1, null)), Number(lua_tointegerx(Lp, 2, null)));
            return 0;
        }
        if (fn.length >= 1 && argc >= 1) {
            const t = lua_type(Lp, 1);
            if (t === LUA_TTABLE) { fn(readRoomTable(Lp, 1)); return 0; }
            if (t === LUA_TUSERDATA) {
                lua_pushvalue(Lp, 1);
                fn(new LuaValue());
                return 0;
            }
        }
        fn(undefined);
        return 0;
    };
}

/**
 * The table a `contents` callback is handed, read by name.
 *
 * There are two of them and this is the union. `l_push_mkroom_table()`
 * (nhlua.c:3059) pushes `width`, `height`, `region = {x1,y1,x2,y2}`, the three
 * booleans `lit`/`irregular`/`needjoining` and the string `type`;
 * `l_push_wid_hei_table()` (nhlua.c:3050) pushes only `width` and `height`.
 *
 * Reading by name rather than walking with lua_next is deliberate and is what
 * the .lua does too — `rm.lit`, `rm.width`, `rm.region.x1`. `lit` in particular
 * is a *boolean*, and themerms.lua's Garden and Light source fills compare it
 * against `true` and `false`, so reading it as an integer would answer nil to
 * both.
 */
function readRoomTable(Lp, idx) {
    const out = {};
    scalarField(Lp, idx, out, 'width', LUA_TNUMBER);
    scalarField(Lp, idx, out, 'height', LUA_TNUMBER);
    lua_getfield(Lp, idx, cstr('region'));
    if (lua_type(Lp, -1) === LUA_TTABLE) {
        const r = {};
        for (const k of ['x1', 'y1', 'x2', 'y2']) scalarField(Lp, -1, r, k, LUA_TNUMBER);
        out.region = r;
    }
    lua_settop(Lp, lua_gettop(Lp) - 1);
    for (const k of ['lit', 'irregular', 'needjoining']) scalarField(Lp, idx, out, k, LUA_TBOOLEAN);
    scalarField(Lp, idx, out, 'type', LUA_TSTRING);
    return out;
}

/** `out[k] = t[k]` when the field is present and has type `want`. */
function scalarField(Lp, idx, out, k, want) {
    lua_getfield(Lp, idx, cstr(k));
    const t = lua_type(Lp, -1);
    if (t === want) {
        out[k] = want === LUA_TNUMBER ? Number(lua_tointegerx(Lp, -1, null))
            : want === LUA_TBOOLEAN ? luaBool(Lp, -1)
                : cptr.cstr(lua_tolstring(Lp, -1, null));
    }
    lua_settop(Lp, lua_gettop(Lp) - 1);
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
    const v = takeResult(Lp, RESULT_FIELDS[`${tbl}.${name}`] ?? COORD_FIELDS);
    lua_settop(Lp, base);       // drop the table
    return v;
}

/**
 * Which fields of a C-built result table a port reads, per binding.
 *
 * A table handed back by a binding is freshly built by that binding, nothing
 * else holds it, and every consumer — the .lua and the C readers alike — takes
 * it apart by name. So the port reads it by name too, from an explicit list
 * per producer rather than by walking it: walking would make the JS object's
 * key order depend on the state's hash seed, and that object is sometimes
 * pushed straight back (`des.trap{ coord = pos }`).
 *
 * `selection.rndcoord()` returns {x,y} and `selection.bounds()` {lx,ly,hx,hy};
 * those are the default. The two obj tables are S7's — themerms.lua reads
 * `xobj.NO_OBJ`/`ox`/`oy` off `otmp:totable()` (nhlobj.c:246) and
 * `itmcls["material"]` off `itm:class()` (nhlobj.c:200).
 */
const COORD_FIELDS = ['x', 'y', 'lx', 'ly', 'hx', 'hy'];
const RESULT_FIELDS = {
    'obj.totable': ['NO_OBJ', 'ox', 'oy'],
    'obj.class': ['material'],
};

/**
 * Whether `des.object()`'s result is taken (S7).
 *
 * lspo_object() always pushes the obj it made, and 1,420 des.object() calls in
 * the corpus ignore it. Taking it costs a registry reference each, so it is off
 * by default and turned on around the one script that binds it —
 * themerms.lua's "Buried zombies" and "Water-surrounded vault". Asking
 * lua_callk for a result the .lua discarded is not observable (moveresults()
 * only pads the caller's own stack, and the C function has already done its
 * work), but the reference would be.
 */
let desObjectResult = false;

/** Run `body` with `des.object()` handing its obj back. @param {() => *} body */
export function withDesObjectResult(body) {
    const saved = desObjectResult;
    desObjectResult = true;
    try { return body(); } finally { desObjectResult = saved; }
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
function takeResult(Lp, fields = COORD_FIELDS) {
    const t = lua_type(Lp, -1);
    if (t === LUA_TNUMBER) {
        const n = lua_tointegerx(Lp, -1, null);
        const v = n === null || n === undefined
            ? lua_tonumberx(Lp, -1, null) : Number(n);
        lua_settop(Lp, lua_gettop(Lp) - 1);
        return v;
    }
    if (t === LUA_TBOOLEAN) {
        const v = luaBool(Lp, -1);
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
        const v = readNumTable(Lp, -1, fields);
        lua_settop(Lp, lua_gettop(Lp) - 1);
        return v;
    }
    return new LuaValue();      // userdata: pops into the registry
}

/**
 * The named fields of a table a binding built — see RESULT_FIELDS.
 *
 * Reading by name rather than walking with lua_next is deliberate: it is what
 * every C consumer of these tables does too (sp_lev.c's get_coord() reads "x"
 * then "y"), so the port never depends on a hash order.
 *
 * `idx` is a stack index of the table itself; it stays valid across the loop
 * because each lua_getfield's result is popped before the next one.
 */
function readNumTable(Lp, idx, fields) {
    const out = {};
    for (const k of fields) {
        lua_getfield(Lp, idx, cstr(k));
        const t = lua_type(Lp, -1);
        const v = t === LUA_TNUMBER ? Number(lua_tointegerx(Lp, -1, null))
            : t === LUA_TSTRING ? cptr.cstr(lua_tolstring(Lp, -1, null)) : undefined;
        lua_settop(Lp, lua_gettop(Lp) - 1);
        if (v !== undefined) out[k] = v;
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
 * call — there are 1,420 of those — rather than about correctness. S7 turns
 * `object` on around themerms.lua alone; see withDesObjectResult().
 */
const DES_VALUE_FUNCS = new Set(['map']);

/** des.* — a call discards its results, as a Lua statement does. */
export const des = Object.freeze(Object.fromEntries(
    DES_FUNCS.map((n) => [n, n === 'object'
        ? (...args) => (desObjectResult
            ? callTable1('des', 'object', args) : callTable('des', 'object', args))
        : DES_VALUE_FUNCS.has(n)
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

// nhlobj.c's l_obj_methods[]. Registered as one table whose metatable __index
// points back at itself, exactly as nhlsel.c does for selections, so
// `o:placeobj(x, y)` and `obj.placeobj(o, x, y)` are the same call and the port
// spells out the second form.
const OBJ_FUNCS = [
    'new', 'isnull', 'at', 'next', 'totable', 'class', 'placeobj', 'container',
    'contents', 'addcontent', 'has_timer', 'peek_timer', 'stop_timer',
    'start_timer', 'bury',
];

/** obj.* — `obj.new(name)` hands back the userdata as an opaque LuaValue. */
export const obj = Object.freeze(Object.fromEntries(
    OBJ_FUNCS.map((n) => [n, (...args) => callTable1('obj', n, args)]),
));

/**
 * Lua's `string` library, as far as this corpus reaches it: `s:match(p)`.
 *
 * A port writes `string.match(s, p)` for the .lua's `s:match(p)`, which is what
 * that sugar means — `luaopen_string` sets the string metatable's `__index` to
 * the library table, so `("x"):match(p)` *is* `string.match("x", p)`. Driving
 * the real `str_match` means the port does not have to reimplement Lua
 * patterns, which are not regular expressions and differ from JS in every
 * detail that matters here.
 *
 * `match` returns the first capture (a JS string), or null when the pattern
 * does not match — `lua_type` reports LUA_TNIL and takeResult() maps it to
 * null, so a port's `m != null` reads the way the .lua's `m ~= nil` does.
 */
export const string = Object.freeze({
    match: (s, pat) => callTable1('string', 'match', [s, pat]),
    format: (fmt, ...args) => callTable1('string', 'format', [fmt, ...args]),
});

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
    return alignIn(L);
}

/**
 * The same, out of a state the caller already has.
 *
 * themerms.lua's port needs this: its state is gl.luathemes[dnum], which is
 * created once per dungeon branch and then *kept*, so by the time a themed room
 * is generated the newest lua_State interpState() would find is some other
 * level's. The port is handed its own state at load and reads `align` from it.
 *
 * @param {object} L
 */
export function alignIn(L) {
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
 * `nh.parse_config(str)` — nhl_parse_config() (nhlua.c), which is exactly
 * `parse_conf_str(luaL_checkstring(L, 1), parse_config_line)` and returns
 * nothing. dat/tut-1.lua turns on three newbie-friendly options with it before
 * it draws anything, and those options change what the rest of the game
 * displays, so the call has to happen at the same point with the same bytes.
 *
 * parse_conf_str() copies out of the string into its own parser buffer
 * (cfgfiles.c) and never writes through the pointer, so handing it an interned
 * cstr() is safe.
 */
export function parseConfig(s) { parse_conf_str(cstr(s), parse_config_line); }

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
 * Every field is a getter, so a port that never mentions `u` never reads
 * NetHack's memory for it. The offsets are nhl_meta_u_index()'s own: that
 * function is a table of {name, &field, type} triples, and the transpiler
 * emitted it as a 24-byte-stride array of literal `cptr.add(u, N)` pointers
 * (js/generated/nhlua.js:1960-2031), so each N below is the transpiler's answer
 * rather than a guess. `role`, `depth` and `moves` are the three special cases
 * nhl_meta_u_index() handles after the table.
 *
 *   ux  @0   ANY_UCHAR    uhunger @104  ANY_INT
 *   uy  @2   ANY_UCHAR    uenmax  @2212 ANY_INT
 *   role     = gu.urole.name.m       depth = depth(&u.uz), &u.uz == u+24
 *   moves    = svm.moves             invocation_level = Invocation_lev(&u.uz)
 *
 * `invocation_level` is pushed with lua_pushboolean (nhlua.js:2058), so it is a
 * Lua boolean rather than the 0/1 the C macro yields; dat/hellfill.lua's
 * `if (u.invocation_level)` reads it.
 */
export const uTable = Object.freeze({
    get depth() { return depth(cptr.add(u, 24)); },
    get invocation_level() { return Invocation_lev(cptr.add(u, 24)) !== 0; },
    get ux() { return cptr.ld1uo(u, 0); },
    get uy() { return cptr.ld1uo(u, 2); },
    get uhunger() { return cptr.ldI32o(u, 104); },
    get uenmax() { return cptr.ldI32o(u, 2212); },
    get role() { return cptr.cstr(cptr.ldPtro(gu, 8)); },
    get moves() { return Number(cptr.ldI64o(svm, 8)); },
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
// Library ports: JS functions the *interpreter* can call
// ---------------------------------------------------------------------------
//
// A level-script port replaces a chunk. A library port replaces a chunk whose
// whole product is a set of globals that somebody else calls later — nhlib.lua
// leaves fourteen of them in every state nhl_init() builds, nhcore.lua eight
// more in gl.luacore, and the callers are C (`lua_getglobal("nh_callback_run")`,
// `l_nhcore_call`), the two .lua scripts S7 has not ported yet
// (themerms/hellfill call percent/shuffle/math.random/d/pline/hell_tweaks and
// read `align`), and nhcore's own `_G[k]` dispatch.
//
// So the port has to put *callable Lua values* in that state, not JS ones. In
// this transpile that is nearly free: lua_pushcclosure() stores the pointer
// verbatim and luaD_precall() invokes it as `n = (f)(L)`, so a JS function is a
// lua_CFunction. The two wrappers below are the calling conventions.

/** The Lua value at `idx`, as the JS value a port body wants to see. */
function toJs(Lp, idx) {
    const t = lua_type(Lp, idx);
    if (t === LUA_TNIL || t < 0) return null;
    if (t === LUA_TBOOLEAN) return luaBool(Lp, idx);
    if (t === LUA_TNUMBER) {
        const n = lua_tointegerx(Lp, idx, null);
        return n === null || n === undefined ? lua_tonumberx(Lp, idx, null) : Number(n);
    }
    if (t === LUA_TSTRING) return cptr.cstr(lua_tolstring(Lp, idx, null));
    // A table or userdata stays on the Lua side, held by a registry reference
    // so the ported body can hand it straight back to another binding — which
    // is what hellfill.lua's `hell_tweaks(protected)` does with its selection.
    lua_pushvalue(Lp, idx);
    return new LuaValue();
}

/**
 * Wrap a JS function as a lua_CFunction with the ordinary calling convention:
 * every argument converted to JS, the return value pushed, and the api bound to
 * the state that made the call.
 *
 * `undefined` means "returned nothing", which is what a Lua function that falls
 * off the end does; anything else (including null, i.e. an explicit `nil`) is
 * one result.
 *
 * @param {(...args: *[]) => *} fn
 */
export function luaFn(fn) {
    // Everything inside withState, argument conversion included: toJs() takes a
    // registry reference for a table or a userdata, and a reference has to be
    // taken in the state the value lives in. Converting first and binding
    // afterwards put luaL_ref on the *port's* state while the value sat on the
    // caller's, which corrupts both — found by seed4500-knight-coverage, the
    // only corpus session that hands a library function a table.
    const cfn = (Lp) => withState(Lp, () => {
        const argc = lua_gettop(Lp);
        const args = [];
        for (let i = 1; i <= argc; i++) args.push(toJs(Lp, i));
        const v = fn(...args);
        if (v === undefined) return 0;
        push(v, Lp);
        return 1;
    });
    cfn.__luaCFunction = true;
    return cfn;
}

/**
 * Wrap a JS function that wants the Lua stack itself: `shuffle` rewrites its
 * table argument in place, `table_stringify` and `nh_callback_run` walk one
 * with lua_next. Converting those to JS and back would be a different program.
 *
 * @param {(Lp: object) => number} fn  returns the number of results pushed
 */
export function luaRawFn(fn) {
    const cfn = (Lp) => withState(Lp, () => fn(Lp));
    cfn.__luaCFunction = true;
    return cfn;
}

/**
 * `<name> = <fn>` in the globals of `Lp`, where fn is already a lua_CFunction.
 * @param {object} Lp @param {string} name @param {Function} cfn
 */
export function defineFn(Lp, name, cfn) {
    lua_pushcclosure(Lp, cfn, 0);
    lua_setglobal(Lp, cstr(name));
}

/** The current value of global `name` in `Lp`, as an opaque LuaValue. */
export function globalValue(Lp, name) {
    const base = lua_gettop(Lp);
    lua_getglobal(Lp, cstr(name));
    const v = withState(Lp, () => new LuaValue());
    lua_settop(Lp, base);
    return v;
}

/** `tbl.field = value` on a global table that already exists (math.random). */
export function setTableField(Lp, tbl, field, value) {
    const base = lua_gettop(Lp);
    try {
        if (lua_getglobal(Lp, cstr(tbl)) !== LUA_TTABLE) {
            throw new Error(`lua-port: global '${tbl}' is not a table`);
        }
        push(value, Lp);
        lua_setfield(Lp, -2, cstr(field));
    } finally {
        lua_settop(Lp, base);
    }
}

/** Lua's `#t` on the value at `idx` — the operator, metamethods included. */
export function luaLenAt(Lp, idx) {
    lua_len(Lp, idx);
    const n = Number(lua_tointegerx(Lp, -1, null) ?? 0n);
    lua_settop(Lp, lua_gettop(Lp) - 1);
    return n;
}

/** Lua's own `tostring`-in-a-concat for the value at `idx`, without changing it. */
export function luaStrAt(Lp, idx) {
    lua_pushvalue(Lp, idx);
    const s = cptr.cstr(lua_tolstring(Lp, -1, null));
    lua_settop(Lp, lua_gettop(Lp) - 1);
    return s;
}

/**
 * Reading and writing a table that lives on the Lua side.
 *
 * nhcore.lua's `nh_lua_variables` is such a table: the port creates it in the
 * interpreter's own state (that is where C reads it back from and where the
 * save file gets it), so a ported `nh_callback_set` has to index *that* table
 * rather than a JS object standing in for it. These are the five things the
 * ported bodies do to it, written the way nhlua.c writes them.
 *
 * A handle is a LuaValue — a registry reference — so it survives across the
 * calls in between. `pairs()` is lua_next, which is the whole answer to §14.4:
 * the port visits exactly what the interpreter's `pairs` would have visited, in
 * exactly that order, because it is the same traversal of the same table.
 */
export const luaTable = {
    /**
     * `t[k]`. A scalar comes back as a JS value; a table comes back as the
     * path to it, so nothing has to be unref'd later.
     */
    getField(t, k) {
        const Lp = state();
        const base = lua_gettop(Lp);
        push(t, Lp);
        const ty = lua_getfield(Lp, -1, cstr(k));
        const v = ty === LUA_TTABLE && t instanceof LuaRef ? t.child(k) : toJs(Lp, -1);
        lua_settop(Lp, base);
        return v;
    },
    /** `t[k] = {}`, and hand the new table back. */
    newTable(t, k) {
        const Lp = state();
        const base = lua_gettop(Lp);
        push(t, Lp);
        lua_createtable(Lp, 0, 0);
        lua_setfield(Lp, -2, cstr(k));
        lua_settop(Lp, base);
        return t instanceof LuaRef ? t.child(k) : luaTable.getField(t, k);
    },
    /** `t[k] = v`. */
    setField(t, k, v) {
        const Lp = state();
        const base = lua_gettop(Lp);
        push(t, Lp);
        push(v, Lp);
        lua_setfield(Lp, -2, cstr(k));
        lua_settop(Lp, base);
    },
    /**
     * `t[k] = nil`.
     *
     * A JS stand-in takes the JS path: nhlib.lua's `tutorial_events` is a
     * file-scope local that never leaves this side, and `tutorial_events[k] =
     * nil` on it must delete a JS slot rather than marshal the whole list into
     * Lua and back.
     */
    setNil(t, k) {
        if (!onLuaSide(t)) { jsSetIndex(t, k, null); return; }
        luaTable.setField(t, k, null);
    },
    /**
     * `pairs(t)`, as the check stub shapes it: `{ __iter() }` over [k, v].
     *
     * For a table that lives in Lua this is lua_next over that very table, in
     * the interpreter's own traversal order — §14.4's whole answer. For a JS
     * stand-in it is jsPairs(), the same iteration the --check interpreter
     * performs, because there is no Lua table to walk.
     */
    pairs(t) {
        if (!onLuaSide(t)) return { __iter: () => jsPairs(t) };
        return {
            __iter() {
                const Lp = state();
                const base = lua_gettop(Lp);
                const out = [];
                push(t, Lp);
                lua_pushnil(Lp);
                while (lua_next(Lp, -2) !== 0) {
                    // The key must be read without converting it in place —
                    // lua_tolstring rewrites a number's slot and that is what
                    // breaks a lua_next traversal. toJs() copies first.
                    const top = lua_gettop(Lp);
                    const k = toJs(Lp, top - 1);
                    const v = toJs(Lp, top);
                    out.push([k, v]);
                    lua_settop(Lp, top - 1);        // pop value, keep key
                }
                lua_settop(Lp, base);
                return out;
            },
        };
    },
};

/**
 * The api a *library* port is handed: everything a level-script port gets, plus
 * the pieces of Lua's own base library that nhlib.lua and nhcore.lua use —
 * bound, here, to whatever state the call came in on.
 *
 * `pairs` being lua_next is the whole of §14.4: a ported `table_stringify` or
 * `nh_callback_run` visits the caller's own Lua table in the caller's own
 * traversal order, so there is no order for the port to reproduce or to get
 * wrong.
 *
 * A fresh object per call, because nhlib.lua's `tutorial_events` is a
 * file-scope local — one list per chunk load, i.e. one per lua_State.
 */
export function libApi() {
    const A = Object.assign({
        des: api.des,
        selection: api.selection,
        obj: api.obj,
        string: api.string,
        nh: api.nh,
        percent: api.percent,
        shuffle: api.shuffle,
        d: api.d,
        math: api.math,
        // Still a getter, and it has to be: libApi() runs *before* the nhlib
        // port has defined `align`, and interpAlign() throws when it is absent.
        get align() { return api.align; },
        monkfoodshop: api.monkfoodshop,
        hell_tweaks: api.hell_tweaks,
        u: api.u,
        nhc: api.nhc,
        luaList: api.luaList,
        luaLen: api.luaLen,
    }, {
        pairs: luaTable.pairs,
        type: luaTypeOf,
        // nhlib.lua's `pline`, as a *global* — themerms.lua calls it by that
        // name four times. It is the same libPline the nhlib port installs into
        // the state; calling it directly rather than through the Lua global is
        // the same code on the same arguments.
        pline: (fmt, ...rest) => libPline(A, fmt, ...rest),
        // S7's lifetime marker: "this value escapes the call that made it".
        // It is part of the api rather than an import so that the ported
        // bodies stay importable without the transpiled game in scope, which
        // is what lets --check run them.
        keepValue,
        tostring: luaToStringOf,
        getField: luaTable.getField,
        newTable: luaTable.newTable,
        setField: luaTable.setField,
        setNil: luaTable.setNil,
        callGlobal,
        nh_lua_variables: new LuaRef('nh_lua_variables'),
    });
    A.table_stringify = (t) => libTableStringify(A, t);
    return A;
}

/** Does this value name a table on the Lua side, or a JS stand-in for one? */
function onLuaSide(t) { return t instanceof LuaRef || t instanceof LuaValue; }

/** Lua's `type()` for a value that came back through toJs(). */
export function luaTypeOf(v) {
    if (v instanceof LuaRef) return 'table';
    if (v instanceof LuaValue) return v.ltype === 6 ? 'function' : v.ltype === 5 ? 'table' : 'userdata';
    return jsType(v);
}

/** Lua's `tostring()` for the same, as `..` would coerce it. */
export function luaToStringOf(v) { return jsToString(v); }

/**
 * `_G[name](...args)` — nhcore.lua's `nh_callback_run` dispatch, the one
 * reflective construct in the corpus. lua_getglobal is exactly `_G[name]`.
 */
export function callGlobal(name, args) {
    const Lp = state();
    const base = lua_gettop(Lp);
    lua_getglobal(Lp, cstr(name));
    for (const a of args) push(a, Lp);
    lua_callk(Lp, args.length, 1, 0n, null);
    const v = luaBool(Lp, -1);
    lua_settop(Lp, base);
    return v;
}

/** Re-exported so a library port can drive the stack the way nhlua.c does. */
export {
    lua_createtable, lua_getfield, lua_getglobal, lua_gettop, lua_len, lua_next,
    lua_pushboolean, lua_pushnil, lua_pushstring, lua_pushvalue, lua_rawgeti,
    lua_rawseti, lua_setfield, lua_settop, lua_toboolean, lua_tointegerx,
    lua_type, cstr,
};

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
    des, selection, obj, string,
    // `pline`, `text`, `callback` and `gamestate` are the four nh.* entries a
    // *library* port calls, and they go through the interpreter's own `nh`
    // table (nhl_functions[]) rather than through a JS transcription — the C
    // side of each is a window-port call or a game-state save, not something
    // worth reimplementing. They therefore only work while the api is bound to
    // a state that has `nh` in it, i.e. inside a library port; the port state
    // has des/selection/obj/string and deliberately nothing else.
    nh: Object.freeze({
        rn2: nhRn2, random: nhRandom, eckey, is_genocided: isGenocided,
        parse_config: parseConfig,
        // level_difficulty() is nhl_level_difficulty()'s whole body and is a
        // plain exported C function, so it is called directly the way depth()
        // is. The rest are staticfn wrappers around a window-port call or a
        // game-state change, and go through the interpreter's own `nh` table —
        // which means they only work while the api is bound to a state that has
        // one, i.e. inside a library or themes port.
        level_difficulty,
        pline: (...args) => callTable('nh', 'pline', args),
        text: (...args) => callTable('nh', 'text', args),
        callback: (...args) => callTable('nh', 'callback', args),
        gamestate: (...args) => callTable('nh', 'gamestate', args),
        impossible: (...args) => callTable('nh', 'impossible', args),
        debug_themerm: (...args) => callTable1('nh', 'debug_themerm', args),
        start_timer_at: (...args) => callTable('nh', 'start_timer_at', args),
    }),
    // Lua's `type()`. dat/hellfill.lua's rnd_hell_prefab() branches on it —
    // its prefab list holds both bare functions and {repeatable, contents}
    // tables — and it is the language rather than NetHack, so it is jsType().
    type: luaTypeOf,
    // `math.random` is nhlib.lua's shim, not JavaScript's: a port writes
    // `math.random(4, 8)` exactly as the .lua does and draws from NetHack's RNG.
    // `floor` and `abs` are Lua's own and are JS's own — themerms.lua uses both,
    // on non-negative integers, where the two languages agree exactly.
    percent, shuffle, d, math: Object.freeze({ random: mathRandom, floor: Math.floor, abs: Math.abs }),
    get align() { return interpAlign(); },
    monkfoodshop: () => monkfoodshopFn(api),
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
