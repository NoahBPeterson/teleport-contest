// nhlib.mjs — the parts of dat/nhlib.lua a *level script* can see, as pure JS.
//
// nhlib.lua is loaded into every lua_State nhl_init() builds, before any level
// script runs, and it puts five things into scope that a level script uses
// directly: a `math.random` that draws from NetHack's RNG instead of Lua's,
// `shuffle`, `d`, `percent`, and Lua's own 1-based list indexing. A ported
// script needs all five to behave *exactly* as the interpreter's do, because
// each of them turns into a specific sequence of rn2() calls and the RNG log
// is the thing the contest scores.
//
// The module is parameterised by rn2 rather than importing it, for one reason:
// tools/lua-port-gen/lua2des.mjs's --check runs a generated port against a
// deterministic stub RNG and compares its call stream with the one the .lua
// describes. Both sides must use the *same* percent/shuffle/math.random code,
// or the check would be comparing two implementations instead of two
// transcriptions. So the real bridge builds these over js/generated/rnd.js's
// rn2 and the checker builds them over a counter; the algorithm is written
// once, here.
//
// Nothing in this file imports anything. It is the only part of the port that
// can be read without the transpiled game in scope.

/**
 * A Lua list: `luaList(a, b, c)[1] === a`, and `luaLen(list) === 3`.
 *
 * Lua tables are 1-based, and the scripts index them with the numbers the .lua
 * uses — `object[1]`, `place[7]`, `monster[10]`. Writing those as 0-based JS
 * arrays would put an off-by-one between every .lua and its port, which is
 * precisely the thing a Phase-2 reviewer diffing the two should not have to
 * hold in their head. Slot 0 exists and is undefined so the value compares
 * identically however it is walked.
 *
 * It is a distinct type rather than a convention because shuffle() has to know
 * where element 1 lives: `#list` is 3 for a Lua list of three, and the number
 * of rn2() draws shuffle spends depends on it.
 */
export class LuaList extends Array {}

/** @param {...*} items @returns {LuaList} */
export function luaList(...items) { return LuaList.from([undefined, ...items]); }

/** Lua's `#t`. @param {*[]} t */
export function luaLen(t) { return t instanceof LuaList ? t.length - 1 : t.length; }

/**
 * Build nhlib.lua's RNG helpers over a given rn2.
 *
 * The draw sequences are nhlib.lua's, statement for statement:
 *
 *   math.random(n)      -> 1 + nh.rn2(n)                       (nhlib.lua:5)
 *   math.random(lo,hi)  -> nh.random(lo, hi + 1 - lo)          (nhlib.lua:9)
 *   nh.random(b,r)      -> b + rn2(r)                          (nhlua.c:1154)
 *   shuffle(list)       -> for i = #list, 2, -1: math.random(i)  (nhlib.lua:17)
 *   percent(t)          -> math.random(0, 99) < t              (nhlib.lua:45)
 *   d(dice, faces)      -> math.random(1, faces), dice times   (nhlib.lua:28)
 *
 * @param {(n: number) => number} rn2
 */
export function makeNhlib(rn2) {
    /** nh.random(base, range) / nh.random(range) — nhl_random(). */
    const nhRandom = (a, b) => (b === undefined ? rn2(a) : (a + rn2(b)) | 0);

    /** nhlib.lua's math.random shim. */
    const mathRandom = (a, b) => (b === undefined ? 1 + rn2(a) : nhRandom(a, (b + 1 - a) | 0));

    /** percent(t) — one rn2(100), whichever way the branch goes. */
    const percent = (t) => mathRandom(0, 99) < t;

    /** d(dice, faces); the one-argument form is 1dN. */
    const d = (dice, faces) => {
        if (faces === undefined) return mathRandom(1, dice);
        let sum = 0;
        for (let i = 0; i < dice; i++) sum += mathRandom(1, faces);
        return sum;
    };

    /**
     * shuffle(list) — descending Fisher-Yates, in place, `#list - 1` draws.
     *
     * Works on a LuaList (element 1 at index 1) and on a plain 0-based array
     * alike; the draw sequence is the same either way because it depends only
     * on the length.
     */
    const shuffle = (list) => {
        const base = list instanceof LuaList ? 1 : 0;
        for (let i = luaLen(list); i >= 2; i--) {
            const j = mathRandom(i);
            const a = base + i - 1, b = base + j - 1;
            const t = list[a]; list[a] = list[b]; list[b] = t;
        }
        return list;
    };

    return { nhRandom, mathRandom, percent, d, shuffle };
}
