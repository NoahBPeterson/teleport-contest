// nhlib.mjs — port of dat/nhlib.lua, the prelude every lua_State gets.
//
// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER PORT. A level script's port
// replaces a chunk that calls C bindings and then goes away. dungeon.lua's and
// quest.lua's replace a chunk whose whole product is one global table. This one
// replaces a chunk that *defines fourteen functions and a table*, in a state
// that is about to run something else — so the port has to leave callable Lua
// values behind, not JS ones:
//
//   * nhl_init() (nhlua.c:2511) loads nhlib.lua into EVERY lua_State it builds:
//     one per level load, one per quest message, one for gl.luacore, one for
//     init_dungeons(). A game makes dozens.
//   * The callers are C (`lua_getglobal("nh_get_variables_string")`,
//     nhlua.c:1407), nhcore.lua's `_G[k]` dispatch, and the two .lua scripts
//     that are still interpreted — themerms.lua and hellfill.lua between them
//     call `percent`, `shuffle`, `math.random`, `d`, `pline` and `hell_tweaks`
//     and read `align`, 90 times over.
//
// So each global becomes a lua_CFunction (bridge.mjs's luaFn/luaRawFn — in this
// transpile a JS function *is* a lua_CFunction) whose body is the ported one.
// Where the port is generated it comes from nhlib-fns.mjs; where the generator
// refuses the construct it comes from ../nhlib.mjs. Both are checked against
// dat/nhlib.lua by checkLibFn on every `node --test`.
//
// THE LOAD-TIME RNG CONTRACT. `align = { "law", "neutral", "chaos" };
// shuffle(align);` at nhlib.lua:24 spends exactly two rn2() draws — rn2(3) then
// rn2(2), from `math.random(i)` for i = 3 and i = 2 — and it does so inside
// *every* nhl_init(). Four stages of this roadmap have been built on that fact:
// §2 says the bridge's own state must not be made with nhl_init() because it
// would duplicate them, and §7.3 says a port that wants `align[1]` must read it
// out of the interpreter's state rather than recompute it. Both still hold. The
// port spends the same two draws, in the same order, at the same seam — the
// fclose of nhlib.lua, which is inside nhl_init() and before anything else runs
// — using the same shuffle() every other port draws through.
//
// Nothing else in the file spends a draw. `d`, `percent`, `math.random`,
// `shuffle` and `hell_tweaks` all spend theirs when they are *called*, which is
// later and by somebody else.

import {
    LuaRef, defineFn, libApi, luaFn, luaLenAt, luaRawFn, setGlobal, setTableField,
    lua_gettop, lua_pushvalue, lua_rawgeti, lua_rawseti, lua_settop,
} from '../bridge.mjs';
import {
    libD, libMathRandom, libPercent, libPline, libTableStringify, libTutorialTurn,
    luaList, makeTutorialEvents, shuffleWith,
} from '../nhlib.mjs';
import {
    hell_tweaks, monkfoodshop, nh_get_variables_string, nh_set_variables_string,
    tutorial_cmd_before, tutorial_enter, tutorial_leave,
} from '../nhlib-fns.mjs';

/**
 * Every name dat/nhlib.lua leaves in the state, in source order, with the Lua
 * type of each. The oracle compares this list against the interpreter's, so a
 * global the port forgot — or one it invented — is a mismatch rather than a
 * surprise fifty levels later. `math.random` is a field of an existing table
 * rather than a global; it is listed with its table.
 */
export const GLOBALS = [
    ['math.random', 'function'],
    ['shuffle', 'function'],
    ['align', 'table'],
    ['d', 'function'],
    ['percent', 'function'],
    ['monkfoodshop', 'function'],
    ['hell_tweaks', 'function'],
    ['pline', 'function'],
    ['nh_set_variables_string', 'function'],
    ['nh_get_variables_string', 'function'],
    ['table_stringify', 'function'],
    ['tutorial_cmd_before', 'function'],
    ['tutorial_enter', 'function'],
    ['tutorial_leave', 'function'],
    ['tutorial_turn', 'function'],
];

/** The global the freshness check looks for before the port runs. */
export const globalName = 'align';

/**
 * `shuffle(list)` as Lua sees it: the table is the caller's and is rewritten in
 * place, so the port cannot hand it to a JS array shuffle and hand it back.
 *
 * The draws still come from the one implementation. shuffleWith() is applied to
 * the *identity permutation*, which spends exactly the draws and performs
 * exactly the swaps it would have performed on the values; the result says
 * where each element ends up, and the values are moved through the Lua stack
 * without a single registry reference.
 */
function luaShuffle(Lp) {
    const n = luaLenAt(Lp, 1);
    if (n < 2) return 0;
    const perm = luaList(...Array.from({ length: n }, (_, k) => k + 1));
    shuffleWith(api.math.random, perm);
    const base = lua_gettop(Lp);
    for (let i = 1; i <= n; i++) lua_rawgeti(Lp, 1, BigInt(i));
    for (let i = 1; i <= n; i++) {
        lua_pushvalue(Lp, base + perm[i]);
        lua_rawseti(Lp, 1, BigInt(i));
    }
    lua_settop(Lp, base);
    return 0;
}

/** The api the ported bodies run against; rebuilt per load (see libApi). */
let api = null;

/**
 * Run the port in place of dat/nhlib.lua's chunk.
 * @param {object} L the interpreter's lua_State, mid-nhl_init()
 */
export default function nhlibPort(L) {
    api = libApi();
    api.tutorial_events = makeTutorialEvents(api);
    const A = api;

    // nhlib.lua:5 — math.random = function(...) … end. nhl_init() has already
    // made sure a `math` table exists (it creates an empty one if the sandbox
    // did not open the library), so this is a field assignment, not a global.
    setTableField(L, 'math', 'random', luaFn((...args) => libMathRandom(A, ...args)));

    // nhlib.lua:17
    defineFn(L, 'shuffle', luaRawFn(luaShuffle));

    // nhlib.lua:24 — the two draws. api.shuffle is the same shuffleWith the
    // Lua-facing one uses, over the same rn2.
    setGlobal(L, 'align', A.shuffle(['law', 'neutral', 'chaos']));

    // nhlib.lua:29, :43, :47, :57
    defineFn(L, 'd', luaFn((dice, faces) => libD(A, dice, faces)));
    defineFn(L, 'percent', luaFn((threshold) => libPercent(A, threshold)));
    defineFn(L, 'monkfoodshop', luaFn(() => monkfoodshop(A)));
    defineFn(L, 'hell_tweaks', luaFn((protectedArea) => hell_tweaks(A, protectedArea)));

    // nhlib.lua:142, :147, :152, :157
    defineFn(L, 'pline', luaFn((fmt, ...rest) => libPline(A, fmt, ...rest)));
    defineFn(L, 'nh_set_variables_string', luaFn((key, tbl) => nh_set_variables_string(A, key, tbl)));
    defineFn(L, 'nh_get_variables_string', luaFn((tbl) => nh_get_variables_string(A, tbl)));
    defineFn(L, 'table_stringify', luaFn((tbl) => libTableStringify(A, tbl)));

    // nhlib.lua:187, :196, :207, :232 — the tutorial half. `tutorial_events` is
    // a file-scope local, i.e. one list per chunk load; makeTutorialEvents()
    // above is that declaration.
    defineFn(L, 'tutorial_cmd_before', luaFn((cmd) => tutorial_cmd_before(A, cmd)));
    defineFn(L, 'tutorial_enter', luaFn(() => tutorial_enter(A)));
    defineFn(L, 'tutorial_leave', luaFn(() => tutorial_leave(A)));
    defineFn(L, 'tutorial_turn', luaFn(() => libTutorialTurn(A)));

    // Referenced only so a reader can see the whole surface in one place.
    void LuaRef;
}
