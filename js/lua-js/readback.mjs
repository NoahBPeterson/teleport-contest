// readback.mjs — the oracle instrument for the read-back scripts.
//
// WHY THE LEVEL FINGERPRINT IS NOT ENOUGH HERE. For a level script the port's
// whole effect is on NetHack's C globals, so hashing the finished level
// (registry.mjs's levelFingerprint) sees everything the script did. dungeon.lua
// and quest.lua produce no C-side effect at all: what they produce is a Lua
// table, and the game reads it afterwards. The right oracle is therefore the
// table itself — every key, every value, in lua_next traversal order, on both
// sides.
//
// That is *stricter* than the game's own read-back. init_dungeons() walks the
// top-level `dungeon` sequence with lua_next and everything below it by name;
// com_pager_core() only ever uses lua_getfield and integer indices. Hashing
// every table with lua_next means the fingerprint is sensitive to hash-part
// layout that C never observes — if the port ever got the array/hash split
// wrong, this catches it even where the game would not have cared.
//
// Both sides of the comparison are taken at the same seam (the fclose of the
// script's own file) so nothing else can have run in between:
//
//   port side   — setGlobal() has just built the table; dump it.
//   interpreter — the chunk has *not* run yet at fclose, so this module runs
//                 it: the registry hands the interpreter a stub, and
//                 runRealChunk() compiles and executes the real bytes on the
//                 same state, at the same point, before dumping. One execution
//                 of the real script either way, driven from the same place.
//
// Everything here is behind C2JS_LUA_READBACK=dump; production never calls it.

import * as cptr from '../cptr.js';
import {
    lua_getfield, lua_getglobal, lua_gettop, lua_next, lua_pcallk, lua_pushnil,
    lua_pushvalue, lua_settop, lua_toboolean, lua_tolstring, lua_type,
} from '../generated/lapi.js';
import { luaL_loadbufferx } from '../generated/lauxlib.js';

const LUA_TNIL = 0, LUA_TBOOLEAN = 1, LUA_TNUMBER = 3, LUA_TSTRING = 4, LUA_TTABLE = 5;

function fnv(h, byte) { return Math.imul(h ^ (byte & 0xFF), 0x01000193) >>> 0; }

/** FNV-1a over a JS string's code units (all quest/dungeon text is ASCII). */
function fnvStr(h, s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h = fnv(h, c);
        if (c > 0xFF) h = fnv(h, c >> 8);
    }
    return h;
}

/** The scalar at `idx` rendered as a string, without converting it in place. */
function scalar(L, idx) {
    const t = lua_type(L, idx);
    if (t === LUA_TNIL) return 'nil';
    if (t === LUA_TBOOLEAN) return lua_toboolean(L, idx) ? 'true' : 'false';
    if (t === LUA_TNUMBER || t === LUA_TSTRING) {
        // lua_tolstring() rewrites a number's slot; doing that to a key is what
        // breaks lua_next mid-traversal, so always read through a copy.
        lua_pushvalue(L, idx);
        const s = cptr.cstr(lua_tolstring(L, -1, null));
        lua_settop(L, lua_gettop(L) - 1);
        return (t === LUA_TSTRING ? 's:' : 'n:') + s;
    }
    return `t${t}`;
}

/**
 * Walk the table at the top of the stack, hashing it two ways at once.
 *
 * `content` is canonical: integer keys in ascending order, then string keys in
 * sorted order. Two tables holding the same data hash the same however they
 * are laid out, so this is the equivalence the port has to satisfy.
 *
 * `traversal` follows raw lua_next order instead. That order is *not* a
 * property of the data: it depends on where each key lands in the node vector,
 * which depends on g->seed, which luai_makeseed() derives from time() and from
 * pointer values (js/generated/lstate.js:34). It is reported so a divergence
 * can be attributed rather than merely observed — and, for the one table
 * NetHack really does walk with lua_next, so it can be checked.
 *
 * @returns {{content: number, traversal: number, n: number}}
 */
function walk(L, content, traversal, n) {
    const entries = [];
    lua_pushnil(L);
    while (lua_next(L, -2) !== 0) {
        const k = scalar(L, -2);
        if (lua_type(L, -1) === LUA_TTABLE) {
            const r = walk(L, 0x811c9dc5, 0x811c9dc5, 0);
            entries.push({ k, c: `{${r.content.toString(16)}}`, t: `{${r.traversal.toString(16)}}` });
            n += r.n;
        } else {
            const v = scalar(L, -1);
            entries.push({ k, c: v, t: v });
        }
        n++;
        lua_settop(L, lua_gettop(L) - 1);                // pop value, keep key
    }
    for (const e of entries) traversal = fnvStr(fnvStr(traversal, e.k), e.t);
    // Integer keys ascending (that is the array part, and lua_next visits it in
    // that order anyway), then the rest by key.
    const isInt = (s) => s.startsWith('n:');
    entries.sort((a, b) => (isInt(a.k) !== isInt(b.k) ? (isInt(a.k) ? -1 : 1)
        : isInt(a.k) ? Number(a.k.slice(2)) - Number(b.k.slice(2)) : (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)));
    for (const e of entries) content = fnvStr(fnvStr(content, e.k), e.c);
    return { content, traversal, n };
}

/**
 * Fingerprint one global table, content and traversal order separately.
 *
 * @param {object} L
 * @param {string} name
 * @returns {{hash: number, order: number, values: number, keys: string[]}}
 *   `keys` is the top-level lua_next order — for `dungeon` that is literally
 *   the sequence init_dungeons() walks (dungeon.c:1278).
 */
export function dumpGlobal(L, name) {
    const base = lua_gettop(L);
    try {
        if (lua_getglobal(L, cptr.lit(name)) !== LUA_TTABLE) {
            return { hash: 0, order: 0, values: 0, keys: ['<not a table>'] };
        }
        const keys = [];
        lua_pushnil(L);
        while (lua_next(L, -2) !== 0) {
            keys.push(scalar(L, -2).slice(2));
            lua_settop(L, lua_gettop(L) - 1);            // pop value, keep key
        }
        const r = walk(L, 0x811c9dc5, 0x811c9dc5, 0);
        return { hash: r.content >>> 0, order: r.traversal >>> 0, values: r.n, keys };
    } finally {
        lua_settop(L, base);
    }
}

/**
 * Fingerprint the globals a *library* script left in `L` (stage S6).
 *
 * A library port's product is not a value the game reads back, it is a set of
 * names the game *calls*. Nothing else in the oracle sees them: the RNG log
 * carries nhlib's two align draws and nothing more, and the level fingerprint
 * carries nothing at all. So this is the check that a library port left the
 * state in the state the chunk would have.
 *
 * For each expected name it records the Lua type actually found, so a global
 * the port forgot reads as `nil` rather than as silence, and a global whose
 * type is wrong (a table where a function belongs — which is how
 * l_nhcore_call() decides a hook is unavailable) is caught. For the tables it
 * also records the content hash and the raw lua_next order, exactly as
 * dumpGlobal() does for a read-back script: `align`'s three entries are the two
 * shuffle draws made visible, and `nhcore`'s three are the hook table.
 *
 * `math.random` is spelled with a dot and is looked up as a field.
 *
 * @param {object} L
 * @param {[string, string][]} spec  [name, expected Lua type] pairs
 */
export function dumpGlobals(L, spec) {
    const out = [];
    for (const [name, want] of spec) {
        const base = lua_gettop(L);
        try {
            const dot = name.indexOf('.');
            let t;
            if (dot < 0) {
                t = lua_getglobal(L, cptr.lit(name));
            } else {
                t = lua_getglobal(L, cptr.lit(name.slice(0, dot)));
                t = t === LUA_TTABLE ? lua_getfield(L, -1, cptr.lit(name.slice(dot + 1))) : LUA_TNIL;
            }
            const row = { name, want, type: TYPE_NAMES[t] ?? `t${t}` };
            if (t === LUA_TTABLE) {
                // The top-level lua_next order, verbatim, so a difference can
                // be *attributed* rather than merely observed — §6.2's eight
                // questtext traversals are the precedent.
                const keys = [];
                lua_pushnil(L);
                while (lua_next(L, -2) !== 0) {
                    keys.push(scalar(L, -2).slice(2));
                    lua_settop(L, lua_gettop(L) - 1);
                }
                const r = walk(L, 0x811c9dc5, 0x811c9dc5, 0);
                row.hash = r.content >>> 0;
                row.order = r.traversal >>> 0;
                row.values = r.n;
                row.keys = keys;
            }
            out.push(row);
        } finally {
            lua_settop(L, base);
        }
    }
    return out;
}

const TYPE_NAMES = {
    [-1]: 'none', 0: 'nil', 1: 'boolean', 2: 'lightuserdata', 3: 'number',
    4: 'string', 5: 'table', 6: 'function', 7: 'userdata', 8: 'thread',
};

/**
 * Compile and run the real .lua bytes on `L`, the way nhl_loadlua() would.
 *
 * Used only by the interpreter side of the oracle, where the registry has
 * handed the interpreter a stub so this is the chunk's single execution.
 * Mirrors nhl_loadlua's own call: strlen-terminated buffer, "(name)" chunk
 * name, no mode string, executed under pcall.
 *
 * @param {object} L
 * @param {Uint8Array} bytes  the file's contents
 * @param {string} name       e.g. "dungeon.lua"
 */
export function runRealChunk(L, bytes, name) {
    const base = lua_gettop(L);
    try {
        const buf = cptr.alloc(bytes.length + 1);
        buf.buf.set(bytes, 0);
        buf.buf[bytes.length] = 0;
        const rc = luaL_loadbufferx(L, buf, cptr.strlen(buf), cptr.lit(`(${name})`), null);
        if (rc !== 0) throw new Error(`lua-port readback: load ${name}: ${cptr.cstr(lua_tolstring(L, -1, null))}`);
        const prc = lua_pcallk(L, 0, 0, 0, 0n, null);
        if (prc !== 0) throw new Error(`lua-port readback: run ${name}: ${cptr.cstr(lua_tolstring(L, -1, null))}`);
    } finally {
        lua_settop(L, base);
    }
}
