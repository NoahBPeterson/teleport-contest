// nhcore.mjs — port of dat/nhcore.lua, the callback registry.
//
// nhcore.lua is loaded exactly once per game, by l_nhcore_init() (nhlua.c:147),
// into `gl.luacore` — the one lua_State that lives as long as the game does.
// The state was made by nhl_init(), so js/lua-js/scripts/nhlib.mjs has already
// run on it and every nhlib global is in place; this port adds nhcore's own.
//
// WHAT C DOES WITH THEM.
//   * `nhcore` is a table of hooks. l_nhcore_call(i) (nhlua.c:171) does
//     lua_getglobal("nhcore") + lua_getfield(nhcore_call_names[i]) and calls it
//     if it is a function, or marks that hook unavailable for the rest of the
//     game if it is not. Four of the seven names are commented out in the .lua,
//     so four hooks disable themselves on their first attempt — that is
//     behaviour the port has to reproduce by *not* defining them.
//   * `nh_callback_set` / `nh_callback_rm` are called by nhl_callback()
//     (nhlua.c:1854) whenever Lua calls nh.callback(); `nh_callback_run` by
//     allmain.c:559, cmd.c:468, do.c:1587 and mklev.c:1423, each gated on
//     nhcb_counts[] so that a game with no registered callback never calls it
//     at all.
//   * `get_variables_string` is called by get_nh_lua_variables() (nhlua.c:1460)
//     when the game is saved, and its result is what the save file carries.
//   * `nh_lua_variables` is read directly by nhl_variable() (nhlua.c:1387).
//
// The functions themselves are ported in ../nhcore.mjs (the three the generator
// refuses) and ../nhcore-fns.mjs (show_getpos_tip, which is in the subset), and
// both are checked against dat/nhcore.lua by checkLibFn on every `node --test`.
//
// NO RNG. Nothing in nhcore.lua draws, at load time or later, so unlike
// nhlib.mjs this port has no draw contract to keep.

import { LuaRef, defineFn, libApi, luaFn, setGlobal } from '../bridge.mjs';
import { libCallbackRm, libCallbackRun, libCallbackSet, libGetVariablesString } from '../nhcore.mjs';
import { show_getpos_tip } from '../nhcore-fns.mjs';

/** Every name dat/nhcore.lua leaves in the state, in source order. */
export const GLOBALS = [
    ['nh_lua_variables', 'table'],
    ['get_variables_string', 'function'],
    ['nh_callback_set', 'function'],
    ['nh_callback_rm', 'function'],
    ['nh_callback_run', 'function'],
    ['mk_dgl_extrainfo', 'function'],
    ['show_getpos_tip', 'function'],
    ['nhcore', 'table'],
];

/** The global the freshness check looks for before the port runs. */
export const globalName = 'nhcore';

/**
 * nhcore.lua:60 `mk_dgl_extrainfo()` — defined, and unreachable.
 *
 * It writes a dgamelaunch status file with `io.open`, and the sandbox does not
 * open Lua's `io` library at all (nhlua.c's nhlL_openlibs grants
 * BASE/COROUTINE/TABLE/STRING/MATH/UTF8 and nothing else), so calling it would
 * raise "attempt to index a nil value (global 'io')" in the interpreter too.
 * It is reachable from exactly two places and neither of them can name it:
 * `nhcore.moveloop_turn` is commented out in the .lua, and nh_callback_run's
 * `_G[k]` only ever looks up a name that was passed to nh.callback(), which in
 * the whole corpus is `tutorial_cmd_before` and `tutorial_turn`.
 *
 * So the port defines it — the global's *type* is the only thing anything can
 * observe, and that has to match — and makes the unreachability an assertion
 * rather than a comment.
 */
function unreachable() {
    throw new Error('lua-port nhcore.lua: mk_dgl_extrainfo() was called, and '
        + 'the reasoning in js/lua-js/scripts/nhcore.mjs says it cannot be');
}

/**
 * Run the port in place of dat/nhcore.lua's chunk.
 * @param {object} L gl.luacore, freshly built by nhl_init()
 */
export default function nhcorePort(L) {
    const A = libApi();

    // nhcore.lua:9 — the table nhl_variable() reads and the save file carries.
    setGlobal(L, 'nh_lua_variables', {});

    // nhcore.lua:13, :17, :28, :39
    defineFn(L, 'get_variables_string', luaFn(() => libGetVariablesString(A)));
    defineFn(L, 'nh_callback_set', luaFn((cb, fn) => libCallbackSet(A, cb, fn)));
    defineFn(L, 'nh_callback_rm', luaFn((cb, fn) => libCallbackRm(A, cb, fn)));
    defineFn(L, 'nh_callback_run', luaFn((cb, ...rest) => libCallbackRun(A, cb, ...rest)));

    // nhcore.lua:60, :108
    defineFn(L, 'mk_dgl_extrainfo', luaFn(unreachable));
    defineFn(L, 'show_getpos_tip', luaFn(() => show_getpos_tip(A)));

    // nhcore.lua:122 — the hook table. Three entries: the other four names in
    // nhcore_call_names[] are commented out in the .lua and must stay absent,
    // because l_nhcore_call() uses their absence to switch the hook off.
    //
    // The values are the *function objects* the two chunks just installed, so
    // they are looked up rather than rebuilt — `enter_tutorial = tutorial_enter`
    // in the .lua is a reference to nhlib's global, not a new closure.
    setGlobal(L, 'nhcore', {
        getpos_tip: new LuaRef('show_getpos_tip'),
        enter_tutorial: new LuaRef('tutorial_enter'),
        leave_tutorial: new LuaRef('tutorial_leave'),
    });
}
