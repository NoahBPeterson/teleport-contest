// dungeon.lua — the dungeon description file, ported.
//
// The whole script is `dungeon = { ... }`: nine dungeon branches, each with a
// name, a depth range, an alignment and optional `levels` / `branches` arrays.
// No control flow, no randomness, no des.* call — the script's only effect is
// the global it leaves behind, which init_dungeons() (dungeon.c:1221) then
// walks to build svd.dungeons[], the special-level chain and the branch list.
//
// So this is not a level-script port: nothing here calls a C binding. The port
// hands the same table to the same lua_State the interpreter's chunk would
// have assigned it in, and every rn2() init_dungeons() spends afterwards — one
// per dungeon for the `chance` roll, then place_level()'s recursion — happens
// in C exactly as before.
//
// Read-back order note: init_dungeons() is the *only* place in NetHack that
// walks a script-built table with lua_next (dungeon.c:1278). The table it
// walks is this one, and it is a pure sequence, so lua_next runs the array
// part in ascending index order and the traversal is fully determined by the
// array length. bridge.mjs's setGlobal() sizes the array part with
// lua_createtable(narr, 0) the way OP_NEWTABLE does, so the two layouts are
// identical rather than merely equivalent. Everything below the top level is
// read by name (lua_getfield) or by integer index (lua_gettable), both
// order-free.

import data from '../data/dungeon.mjs';

/** The global this script defines; the registry checks it was not there yet. */
export const globalName = 'dungeon';

/** @param {{setGlobal: (name: string, value: *) => void}} api */
export default function dungeon({ setGlobal }) {
    setGlobal('dungeon', data);
}
