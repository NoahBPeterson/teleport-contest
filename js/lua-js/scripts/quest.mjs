// quest.lua — every line of quest prose in the game, ported.
//
// 132 KB, 3,087 lines, and not one executable statement: the file is
// `questtext = { ... }`, a table of sections (`common`, plus one per role
// filecode: `Arc`, `Bar`, `Cav`, ...) each mapping a message id to either
// `{ text = "...", output = "..." }` or a plain array of alternative strings.
//
// com_pager_core() (questpgr.c:494) re-loads the file for *every* message it
// delivers — nhl_init(), nhl_loadlua(), read, nhl_done() — then does
//
//     lua_getglobal(L, "questtext")
//     lua_getfield(L, -1, section)          -- "common" or the role filecode
//     lua_getfield(L, -1, msgid)            -- via questtext.msg_fallbacks
//     get_table_str_opt(L, "text")          -- or lua_len + lua_gettable(rn2)
//
// all of it by name or by integer index, never with lua_next: quest.lua has no
// traversal-order exposure at all. What it does have is a *lifetime*: the
// table must exist in the state the pager just built, which is why this port
// goes through the interpreter's lua_State rather than the port-owned one.
//
// The one RNG draw on this path is C's: when an entry has no `text` field it
// is an array of alternatives and com_pager_core() picks with rn2(nelems), so
// the array lengths this table reports have to match the interpreter's
// exactly. They do by construction — setGlobal() sizes the array part with
// lua_createtable(n, 0), which is what OP_NEWTABLE would have encoded.
//
// Reachability: this is not a quest-only script. newgame() delivers the opening
// message with com_pager("legacy") (allmain.c:832) whenever flags.legacy is
// set, which is the default — so every recorded session in the corpus loads
// quest.lua, reads questtext.common.legacy back out and puts it on the screen.

import data from '../data/quest.mjs';

/** The global this script defines; the registry checks it was not there yet. */
export const globalName = 'questtext';

/** @param {{setGlobal: (name: string, value: *) => void}} api */
export default function quest({ setGlobal }) {
    setGlobal('questtext', data);
}
