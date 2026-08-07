// nhcore.mjs — the hand-written half of dat/nhcore.lua's port.
//
// nhcore.lua is loaded once per game, into gl.luacore (nhlua.c:147), and lives
// until the game exits. What it leaves behind is a table (`nhcore`, which
// l_nhcore_call() looks up by name for each of its seven hooks), a table the
// save file carries (`nh_lua_variables`), and four functions C calls directly
// by `lua_getglobal`:
//
//   nh_callback_set / nh_callback_rm   nhl_callback()  (nhlua.c:1854)
//   nh_callback_run                    allmain.c:559, cmd.c:468, do.c:1587,
//                                      mklev.c:1423 — each gated on
//                                      nhcb_counts[], i.e. only after
//                                      nh.callback() has registered something
//   get_variables_string               get_nh_lua_variables() (nhlua.c:1460),
//                                      at save time
//
// The three in this file are the ones the generator refuses: they assign
// through an index, they call `type()`, and `nh_callback_run` is a generic
// `for k, v in pairs(...)` over a table plus `_G[k](table.unpack{...})` — the
// one reflective construct in the whole 131-file corpus. `show_getpos_tip` is
// in the subset and is generated into nhcore-fns.mjs instead.
//
// Each is proved the same way a generated one is: checkLibFn runs dat/nhcore.lua's
// own body beside it on the same stub api and the same RNG, and compares the
// call stream, the return value and the draws spent. See
// tools/lua-port-gen/gen-ports.mjs's HAND_FNS.
//
// `api` supplies what the .lua reached for as a free name — `nh_lua_variables`,
// `table_stringify`, `_G`, `pairs`, `type`, `setNil` — so the same body serves
// the real game (js/lua-js/scripts/nhcore.mjs binds those to the interpreter's
// own lua_State, so `pairs` is literally lua_next over the caller's table) and
// the generator's --check (a recording stub).

/** nhcore.lua:13 `get_variables_string()`. */
export function libGetVariablesString(api) {
    return `nh_lua_variables=${api.table_stringify(api.nh_lua_variables)};`;
}

/**
 * nhcore.lua:17 `nh_callback_set(cb, fn)`.
 *
 * `nh_lua_variables["_CB_" .. cb][fn] = true`, creating the inner table if it
 * is not one already. The set of callbacks for an event is therefore a table
 * keyed by *function name*, which is what makes nh_callback_run's `_G[k]`
 * dispatch work — and what makes its traversal order a question at all (§14.4).
 *
 * The tables are Lua's, so the port reaches them through the api's accessors
 * rather than through JS property syntax: in the game `getField`/`newTable`/
 * `setField` are lua_getfield / lua_createtable+lua_setfield / lua_setfield on
 * the interpreter's own state, which is where the save file reads them back
 * from.
 */
export function libCallbackSet(api, cb, fn) {
    const cbname = `_CB_${cb}`;
    let t = api.getField(api.nh_lua_variables, cbname);
    if (api.type(t) !== 'table') t = api.newTable(api.nh_lua_variables, cbname);
    api.setField(t, fn, true);
}

/** nhcore.lua:28 `nh_callback_rm(cb, fn)`. */
export function libCallbackRm(api, cb, fn) {
    const cbname = `_CB_${cb}`;
    let t = api.getField(api.nh_lua_variables, cbname);
    if (api.type(t) !== 'table') t = api.newTable(api.nh_lua_variables, cbname);
    api.setNil(t, fn);
}

/**
 * nhcore.lua:39 `nh_callback_run(cb, ...)`.
 *
 * Calls every registered callback for `cb` in `pairs` order and stops at the
 * first one that returns a false value, which is how cmd.c:468 vetoes an
 * extended command in the tutorial.
 *
 * The traversal order is the caller's, not this port's: `api.pairs` in the game
 * is lua_next over the very table the interpreter would have walked, so the
 * order is identical by construction rather than by agreement. It is also
 * unobservable in every reachable configuration — nh.callback() is called from
 * exactly two places in the corpus, nhlib.lua's tutorial_enter and
 * tutorial_leave, and each registers one function per event, so every `_CB_*`
 * table has at most one key. §14.4 has the measurement.
 *
 * `_G[k](table.unpack{...})` is the one reflective construct in the corpus;
 * `api.callGlobal` is a lua_getglobal + lua_call in the game.
 */
export function libCallbackRun(api, cb, ...rest) {
    const cbname = `_CB_${cb}`;
    let t = api.getField(api.nh_lua_variables, cbname);
    if (api.type(t) !== 'table') t = api.newTable(api.nh_lua_variables, cbname);
    for (const [k] of api.pairs(t).__iter()) {
        if (!api.callGlobal(k, rest)) {
            return false;
        }
    }
    return true;
}
