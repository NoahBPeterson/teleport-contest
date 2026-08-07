// nhlib.mjs — dat/nhlib.lua's algorithms, as pure JS.
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
// S6 ADDED THE OTHER HALF. Porting nhlib.lua as a *chunk* (see
// js/lua-js/scripts/nhlib.mjs) means every one of its fifteen globals has to
// exist, because C, nhcore.lua's `_G[k]` dispatch and the two files S7 still
// owns all call them. The ones the generator can transcribe are in
// js/lua-js/nhlib-fns.mjs; the ones it refuses — varargs, a generic `for`,
// simultaneous assignment through an index, Lua's base library — are the
// `lib*` functions at the bottom of this file, each a transliteration of one
// nhlib.lua function parameterised by an `api` so that the same body serves
// the game, the --check stub and a ported level script.
//
// Splitting the algorithms out of makeNhlib() is what lets checkLibFn compare
// them with dat/nhlib.lua's own statements. Before S6 it could not: --check
// handed *both* sides makeNhlib(), so shuffle and math.random — which every
// draw in 127 ports goes through — were the one thing in the roadmap that had
// never been checked against the source.
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
 * The entries a Lua `pairs()` would visit over a *JS* stand-in for a Lua table,
 * as [key, value] pairs.
 *
 * A positional table is a JS array here (0-based) or a LuaList (1-based); both
 * stand for a Lua sequence, so the keys are 1..n either way. A record table is
 * a JS object and the keys are its own, in insertion order.
 *
 * Two callers, and it matters that they are the same code: the ported
 * `tutorial_turn` walks nhlib.lua's `tutorial_events`, which is a file-scope
 * local that never leaves JS, and lua2des.mjs's --check interpreter walks every
 * table on the .lua side. A Lua table that belongs to the *game* is a different
 * matter entirely and is walked with lua_next — see bridge.mjs's luaTable.pairs
 * and NOTES-lua-port.md §14.4.
 */
export function jsPairs(t) {
    if (t instanceof LuaList) {
        const out = [];
        for (let i = 1; i < t.length; i++) if (t[i] !== undefined) out.push([i, t[i]]);
        return out;
    }
    if (Array.isArray(t)) {
        const out = [];
        for (let i = 0; i < t.length; i++) if (t[i] !== undefined) out.push([i + 1, t[i]]);
        return out;
    }
    if (t && typeof t === 'object') return Object.keys(t).map((k) => [k, t[k]]);
    throw new Error('lua-port: pairs() on a non-table');
}

/** `t[k] = v` over the same stand-ins; `v == null` removes the key. */
export function jsSetIndex(t, k, v) {
    const nil = v === null || v === undefined;
    if (t instanceof LuaList) { t[k] = nil ? undefined : v; return; }
    if (Array.isArray(t)) { t[k - 1] = nil ? undefined : v; return; }
    if (t && typeof t === 'object') { if (nil) delete t[k]; else t[k] = v; return; }
    throw new Error('lua-port: assignment through a non-table');
}

/** Lua's `type()`, for a JS stand-in. */
export function jsType(v) {
    if (v === null || v === undefined) return 'nil';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'function') return 'function';
    return 'table';
}

/** Lua's `tostring()`, as `..` coerces the values this corpus stringifies. */
export function jsToString(v) {
    if (v === null || v === undefined) return 'nil';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
}

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
    const mathRandom = (a, b) => mathRandomWith((n) => 1 + rn2(n), nhRandom, a, b);

    /** percent(t) — one rn2(100), whichever way the branch goes. */
    const percent = (t) => percentWith(mathRandom, t);

    /** d(dice, faces); the one-argument form is 1dN. */
    const d = (dice, faces) => dWith(mathRandom, dice, faces);

    /**
     * shuffle(list) — descending Fisher-Yates, in place, `#list - 1` draws.
     *
     * Works on a LuaList (element 1 at index 1) and on a plain 0-based array
     * alike; the draw sequence is the same either way because it depends only
     * on the length.
     */
    const shuffle = (list) => shuffleWith(mathRandom, list);

    return { nhRandom, mathRandom, percent, d, shuffle };
}

// ---------------------------------------------------------------------------
// The algorithms, one copy each, parameterised by what they draw through
// ---------------------------------------------------------------------------
//
// S6 split these out of makeNhlib() so that checkLibFn can compare each against
// dat/nhlib.lua's own body. That comparison is not decoration: `shuffle` and
// `math.random` are what every `percent()`, every `d()` and every shuffled list
// in 127 ports draws through, and until S6 nothing had ever checked them
// against the .lua — the generator's --check handed *both* sides the same
// makeNhlib(), so it compared two transcriptions of a function it also
// supplied. Now the .lua side runs nhlib.lua's statements and the JS side runs
// these, and what is shared between them is only the primitive underneath.

/** nhlib.lua:5 — `1 + nh.rn2(n)`, or `nh.random(lo, hi + 1 - lo)`. */
export function mathRandomWith(oneArg, nhRandom, a, b) {
    if (b === undefined || b === null) return oneArg(a);
    return nhRandom(a, (b + 1 - a) | 0);
}

/** nhlib.lua:43 — `math.random(0, 99) < threshold`. */
export function percentWith(mathRandom, threshold) {
    return mathRandom(0, 99) < threshold;
}

/** nhlib.lua:29 — `d(20)` is 1d20; `d(2, 6)` is 2d6, `dice` draws. */
export function dWith(mathRandom, dice, faces) {
    if (faces === undefined || faces === null) return mathRandom(1, dice);
    let sum = 0;
    for (let i = 1; i <= dice; i++) sum += mathRandom(1, faces);
    return sum;
}

/**
 * nhlib.lua:17 — `for i = #list, 2, -1 do local j = math.random(i);
 * list[i], list[j] = list[j], list[i] end`.
 *
 * Descending Fisher-Yates, in place, `#list - 1` draws. Works on a LuaList
 * (element 1 at index 1) and on a plain 0-based array alike; the draw sequence
 * depends only on the length either way.
 */
export function shuffleWith(mathRandom, list) {
    const base = list instanceof LuaList ? 1 : 0;
    for (let i = luaLen(list); i >= 2; i--) {
        const j = mathRandom(i);
        const a = base + i - 1, b = base + j - 1;
        const t = list[a]; list[a] = list[b]; list[b] = t;
    }
    return list;
}

// ---------------------------------------------------------------------------
// The hand-written library ports, in the `(api, …)` shape checkLibFn drives
// ---------------------------------------------------------------------------
//
// Each is a transliteration of one function of dat/nhlib.lua that the
// generator refuses — varargs, a generic `for`, assignment through an index,
// or Lua's own base library. `api` supplies whatever the .lua reached for as a
// free name, so the same body serves three callers: the real game (where `api`
// drives the interpreter's lua_State — js/lua-js/scripts/nhlib.mjs), the
// generator's --check (where it is a recording stub), and a ported level
// script.

/** nhlib.lua:5 `math.random = function(...)`. */
export function libMathRandom(api, ...args) {
    if (args.length === 1) return 1 + api.nh.rn2(args[0]);
    if (args.length === 2) return api.nh.random(args[0], args[1] + 1 - args[0]);
    throw new Error('NetHack math.random requires at least one parameter');
}

/** nhlib.lua:17 `shuffle(list)`. */
export function libShuffle(api, list) { shuffleWith(api.math.random, list); }

/** nhlib.lua:43 `percent(threshold)`. */
export function libPercent(api, threshold) { return percentWith(api.math.random, threshold); }

/** nhlib.lua:29 `d(dice, faces)`. */
export function libD(api, dice, faces) { return dWith(api.math.random, dice, faces); }

/**
 * nhlib.lua:157 `table_stringify(tbl)`.
 *
 * The one `pairs()` in nhlib.lua, and the reason §14.4 exists. The traversal
 * order is the caller's: in the game `api.pairs` walks the caller's own Lua
 * table with lua_next, so the port visits exactly what the interpreter's
 * `pairs` would have, in exactly that order, by construction rather than by
 * agreement.
 */
export function libTableStringify(api, tbl) {
    let str = '';
    for (const [key, value] of api.pairs(tbl).__iter()) {
        const typ = api.type(value);
        if (typ === 'table') {
            str = `${str}["${key}"]=${libTableStringify(api, value)}`;
        } else if (typ === 'string') {
            str = `${str}["${key}"]=[[${value}]]`;
        } else if (typ === 'boolean') {
            str = `${str}["${key}"]=${api.tostring(value)}`;
        } else if (typ === 'number') {
            str = `${str}["${key}"]=${api.tostring(value)}`;
        } else if (typ === 'nil') {
            str = `${str}["${key}"]=nil`;
        }
        str = `${str},`;
    }
    return `{${str}}`;
}

/**
 * nhlib.lua:142 `pline(fmt, ...)`.
 *
 * `nh.pline(string.format(fmt, table.unpack({...})))`. `table.unpack` of the
 * varargs table is the varargs themselves for every call in the corpus — none
 * passes a nil — so spreading them is the same expansion.
 */
export function libPline(api, fmt, ...rest) {
    api.nh.pline(api.string.format(fmt, ...rest));
}

/**
 * nhlib.lua:232 `tutorial_turn()`, and the `tutorial_events` list it walks.
 *
 * The list is a file-scope `local` in the .lua, i.e. an upvalue created once
 * when the chunk loaded and mutated as events fire — `tutorial_events[k] = nil`
 * removes an event that has done its job. `makeTutorialEvents()` builds one per
 * chunk load, which is what a fresh nhl_init() gets.
 */
export function makeTutorialEvents(api) {
    return [
        {
            func: () => {
                if (api.u.uhunger < 148) {
                    const o = api.obj.new('blessed food ration');
                    api.obj.placeobj(o, api.u.ux, api.u.uy);
                    api.nh.pline("Looks like you're getting hungry.  You'll starve to death, unless you eat something.", true);
                    api.nh.pline(`Comestibles are eaten with '${api.nh.eckey('eat')}'`, true);
                    return true;
                }
                return undefined;
            },
        },
    ];
}

/**
 * nhlib.lua:232 `tutorial_turn()`.
 *
 * `events` is the live list; an entry that returns true, or carries `remove`,
 * is deleted. The .lua's `v.ucoord` guard is dead code today — no event in the
 * list has a `ucoord` — but it is transcribed rather than folded away, because
 * a 5.1 that adds one has to keep working.
 */
export function libTutorialTurn(api) {
    const events = api.tutorial_events;
    for (const [k, v] of api.pairs(events).__iter()) {
        if ((v.ucoord && api.u.ux === v.ucoord[1] + 3 && api.u.uy === v.ucoord[2] + 3)
            || (v.ucoord === undefined || v.ucoord === null)) {
            if (v.func() || v.remove) {
                api.setNil(events, k);
            }
        }
    }
}
