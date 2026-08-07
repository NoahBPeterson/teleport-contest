// themerms.mjs — port of dat/themerms.lua, the themed-room generator.
//
// THE ONE SCRIPT WHOSE STATE OUTLIVES ITS LOAD. Every other .lua in the corpus
// runs inside one nhl_loadlua() and is done: a level script's state is thrown
// away with the level, dungeon.lua's and quest.lua's are closed by the function
// that opened them, and nhlib.lua's is whatever state nhl_init() was building.
// themerms.lua is different, and it is the only one:
//
//     makerooms() (mklev.c:366)
//       themes = gl.luathemes[u.uz.dnum]              -- may already exist
//       if (!themes) { themes = nhl_init(&sbi);        -- 1 MB sandbox
//                      nhl_loadlua(themes, "themerms.lua");
//                      gl.luathemes[u.uz.dnum] = themes; }   -- and KEPT
//       lua_getglobal(themes, "pre_themerooms_generate");  nhl_pcall_handle
//       while (…) lua_getglobal(themes, "themerooms_generate"); nhl_pcall_handle
//       lua_getglobal(themes, "post_themerooms_generate"); nhl_pcall_handle
//     themerooms_post_level_generate() (mklev.c:1174)
//       lua_getglobal(themes, "post_level_generate"); nhl_pcall_handle
//       lua_gc(themes, LUA_GCCOLLECT)
//
// The chunk therefore runs **once per dungeon branch** — only the Dungeons of
// Doom names a themerms file (dungeon.lua:13) — and C calls back into what it
// left behind on every ordinary level of that branch until free_luathemes()
// releases it (mklev.c:345, from do.c:1646 on entering the endgame or leaving
// the tutorial, and from save.c:1067 at the end of the game).
//
// So this is a *library* port in the sense §14.2 established for nhlib.lua: its
// product is a set of names in a lua_State it does not own, four of which C
// calls by name. js/lua-js/scripts/nhlib.mjs is the template, and everything
// here is built inside the port function rather than at module scope, because
// one load means one set of closures over one `postprocess` queue — exactly one
// chunk load's worth of upvalues.
//
// THREE THINGS THIS PORT NEEDS THAT NO EARLIER ONE DID.
//
//   * des.object()'s **return value**. lspo_object() always pushes the obj it
//     made and 1,420 calls in the corpus ignore it; two here do not. Taking it
//     costs a registry reference, so bridge.mjs keeps it off by default and
//     withDesObjectResult() turns it on around this script alone.
//   * **Lifetimes.** The state is memory-capped at 1 MB and lives for a whole
//     branch, so a leaked `selection.room()` — over a kilobyte of userdata —
//     would exhaust it inside one game. The interpreter does not leak them:
//     they are Lua locals, collected by the LUA_GCCOLLECT above. The port
//     reproduces exactly the .lua's two lifetimes: withCallValues() releases
//     everything a room generator took when the C entry point returns, and
//     keepValue() marks the one value that escapes into `postprocess` (the
//     Garden fill's selection) so that post_level_generate() releases it
//     instead.
//   * **`ipairs`.** post_level_generate() walks `postprocess`, which is only
//     ever appended to with table.insert and reset to `{}`, so it is a pure
//     sequence and `ipairs` visits 1..n by the language's own definition. §15
//     measures the analogous claim on this state's two other sequences.
//
// WHY THE TWO BIG TABLES ARE MIRRORED INTO THE STATE. `themerooms` and
// `themeroom_fills` are the port's own JS data — the reservoir sampling walks
// them, and nothing in C ever reads them — so they would not have to exist on
// the Lua side at all. They are nevertheless built there, because that turns
// the S6 globals dump into a real check on the *data* half of this file: the
// dump hashes 31 room entries and 15 fill entries with their names, their
// frequencies and their mindiffs against the interpreter's, and a function
// value hashes as its type on both sides. Nothing else in the oracle would
// notice a mistyped frequency until a game happened to roll that room.

import {
    alignIn, defineFn, libApi, luaFn, releaseKeptValues, setGlobal,
    withCallValues, withDesObjectResult,
} from '../bridge.mjs';
import { makeThemerms } from '../themerms-fns.mjs';

/**
 * Every name dat/themerms.lua leaves in the state, in source order, with the
 * Lua type of each. The oracle compares this list against the interpreter's.
 *
 * `debug_rm_idx` and `debug_fill_idx` are `nil` at load — the .lua assigns nil
 * to them explicitly — and stay nil unless the game is in wizard mode with
 * THEMERM set in the environment, which no recorded session is. Listing them
 * makes that an assertion rather than an assumption.
 */
export const GLOBALS = [
    ['themeroom_fills', 'table'],
    ['themerooms', 'table'],
    ['debug_rm_idx', 'nil'],
    ['debug_fill_idx', 'nil'],
    ['filler_region', 'function'],
    ['is_eligible', 'function'],
    ['lookup_by_name', 'function'],
    ['themerooms_generate', 'function'],
    ['pre_themerooms_generate', 'function'],
    ['post_themerooms_generate', 'function'],
    ['themeroom_fill', 'function'],
    ['make_dig_engraving', 'function'],
    ['make_garden_walls', 'function'],
    ['make_a_trap', 'function'],
    ['post_level_generate', 'function'],
];

/** The global the freshness check looks for before the port runs. */
export const globalName = 'themerooms';

/**
 * Run the port in place of dat/themerms.lua's chunk.
 *
 * @param {object} L  gl.luathemes[dnum], mid-makerooms(), fully nhl_init()ed
 */
export default function themermsPort(L) {
    const api = libApi();
    // nhlib.lua's shuffled `align`, out of *this* state rather than out of
    // whichever one interpState() would find: by the time a themed room is
    // generated the newest lua_State is some other level's. It is shuffled once
    // per state, at that state's nhl_init(), and never changes afterwards.
    Object.defineProperty(api, 'align', { value: alignIn(L), enumerable: true });
    const g = makeThemerms(api);

    // The two data tables, mirrored into the state so the globals dump can
    // compare 31 room entries and 15 fill entries — names, frequencies and
    // mindiffs — against the interpreter's. See the module header.
    setGlobal(L, 'themeroom_fills', g.themeroom_fills);
    setGlobal(L, 'themerooms', g.themerooms);

    // themerms.lua:874 — `debug_rm_idx = nil` / `debug_fill_idx = nil`.
    // Assigning nil to a global that does not exist defines nothing, on either
    // side; they are in GLOBALS so the oracle asserts both stay nil.

    // Every global the chunk defines, in source order. Four of them are called
    // by C — pre_themerooms_generate, themerooms_generate,
    // post_themerooms_generate (mklev.c:396, :415, :432) and post_level_generate
    // (mklev.c:1186) — and the rest are called only from inside the script,
    // where the port reaches the JS function directly. They are all defined
    // anyway because the *set* of globals and the Lua type of each is
    // observable and the oracle compares it.
    //
    // Each wrapper opens the two lifetimes the module header describes: the
    // call-scoped value pool, and des.object()'s return value.
    const entry = (body) => (...args) => withCallValues(
        () => withDesObjectResult(() => body(...args)),
    );
    defineFn(L, 'filler_region', luaFn(entry((x, y) => g.filler_region(x, y))));
    defineFn(L, 'is_eligible', luaFn(entry((room, mkrm) => g.is_eligible(room, mkrm))));
    defineFn(L, 'lookup_by_name', luaFn(entry((n, cf) => g.lookup_by_name(n, cf))));
    defineFn(L, 'themerooms_generate', luaFn(entry(() => g.themerooms_generate())));
    defineFn(L, 'pre_themerooms_generate', luaFn(entry(() => g.pre_themerooms_generate())));
    defineFn(L, 'post_themerooms_generate', luaFn(entry(() => g.post_themerooms_generate())));
    defineFn(L, 'themeroom_fill', luaFn(entry((rm) => g.themeroom_fill(rm))));
    defineFn(L, 'make_dig_engraving', luaFn(entry((data) => g.make_dig_engraving(data))));
    defineFn(L, 'make_garden_walls', luaFn(entry((data) => g.make_garden_walls(data))));
    defineFn(L, 'make_a_trap', luaFn(entry((data) => g.make_a_trap(data))));
    defineFn(L, 'post_level_generate', luaFn(entry(() => {
        g.post_level_generate();
        // The Garden fill's selections escaped their room generator and were
        // read by make_garden_walls() just now; `postprocess = {}` inside
        // post_level_generate() is where the .lua drops its last reference to
        // them, and the LUA_GCCOLLECT at the end of
        // themerooms_post_level_generate() is where the interpreter collects
        // them.
        releaseKeptValues();
    })));
}
