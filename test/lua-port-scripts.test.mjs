/**
 * The transcription check for the generated level-script ports.
 *
 * js/lua-js/scripts/t{0,1,2}/*.mjs are generated from nethack-c/recorder/dat/*.lua
 * by tools/lua-port-gen/lua2des.mjs. Once committed they are ordinary source:
 * reviewers diff them, and a 5.1 update will edit them. This test re-parses
 * each .lua, evaluates the call stream it describes, runs the committed module
 * against a recording stub, and requires the two streams to be equal — every
 * call, every argument, every table key, in order.
 *
 * Both sides are driven by the *same* deterministic RNG object and the same
 * copy of nhlib's percent/shuffle/math.random (js/lua-js/nhlib.mjs), so for the
 * T1 and T2 tiers the comparison also pins the script's own draw sequence: a port that
 * takes the other arm of an `if percent(…)`, or shuffles a list of the wrong
 * length, spends a different number of draws, desynchronises the shared counter
 * and diverges. checkPort() runs several RNG settings including one that forces
 * every percent() true and one that forces every percent() false, so both arms
 * of every branch are checked rather than whichever one a draw happened to pick.
 *
 * It is a source-vs-source check and needs no game, which is what makes it
 * cheap enough to run on every `node --test`. What it protects against is the
 * whole class of error the generator exists to avoid:
 *
 *   * a hand-edit to a generated module that quietly changes a coordinate;
 *   * an editor or formatter stripping the trailing spaces off a `des.map`
 *     template literal — 21 of the 34 T0 maps have them, and they are
 *     load-bearing;
 *   * a .lua updated without regenerating its port.
 *
 * It does *not* prove the port produces the same level: that is the differential
 * oracle's job (tools/lua-oracle.mjs, and NOTES-lua-port.md §7.7 / §11.4's
 * evidence tables). This proves the port says what the .lua says.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLibFn, checkPort } from '../tools/lua-port-gen/lua2des.mjs';
import { HAND_FNS, LIB_ARGV, LIB_MODULES, T0, T1, T2, T3 } from '../tools/lua-port-gen/gen-ports.mjs';
import { makeTutorialEvents } from '../js/lua-js/nhlib.mjs';
import { T0_PORTS } from '../js/lua-js/scripts/t0/index.mjs';
import { T1_PORTS } from '../js/lua-js/scripts/t1/index.mjs';
import { T2_PORTS } from '../js/lua-js/scripts/t2/index.mjs';
import { T3_PORTS } from '../js/lua-js/scripts/t3/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIERS = [
    { tier: 't0', list: T0, ports: T0_PORTS },
    { tier: 't1', list: T1, ports: T1_PORTS },
    { tier: 't2', list: T2, ports: T2_PORTS },
    { tier: 't3', list: T3, ports: T3_PORTS },
];

let failures = 0;
let checked = 0;

// The library ports first, generated and hand-written alike. Seven T2 scripts
// end by calling hell_tweaks(), so a wrong library port would show up as seven
// wrong level scripts; and `shuffle` and `math.random` are what every percent(),
// every d() and every shuffled list in 127 ports draws through, so a wrong one
// would show up as the whole corpus. Checking each on its own says which it is.
//
// The comparison is the same one a level script gets and three things more:
// the *return value* (which is the whole observable of percent, d,
// monkfoodshop, table_stringify and tutorial_cmd_before), the number of rn2()
// draws spent, and any mutation of an argument (which is what shuffle is).
const JS_LOCALS = { tutorial_turn: (a) => { a.tutorial_events = makeTutorialEvents(a); } };
const LIB_CASES = [
    ...LIB_MODULES.flatMap((m) => m.fns.map((f) => ({
        name: f.name, from: m.from, mod: m.out, fn: f.name, locals: f.locals ?? [],
    }))),
    ...HAND_FNS.map((f) => ({
        name: f.name, from: f.from, mod: f.mod, fn: f.fn, locals: f.locals ?? [],
    })),
];
for (const c of LIB_CASES) {
    // eslint-disable-next-line no-await-in-loop
    const d = await checkLibFn(
        path.join(ROOT, `nethack-c/recorder/dat/${c.from}.lua`),
        path.join(ROOT, c.mod),
        c.name,
        { fn: c.fn, locals: c.locals, argvs: LIB_ARGV[c.name], jsLocals: JS_LOCALS[c.name] },
    );
    if (d) { console.error(`FAIL ${c.mod} differs from ${c.from}.lua at ${d}`); failures++; }
    checked++;
}

for (const { tier, list, ports } of TIERS) {
    // The index the registry loads from must list exactly the tier, in order: a
    // port that exists on disk but is not registered would never run, and one
    // registered but missing would throw at boot.
    const registered = [...ports.keys()];
    const expected = list.map((b) => `${b}.lua`);
    if (registered.length !== expected.length || registered.some((k, i) => k !== expected[i])) {
        console.error(`FAIL ${tier}/index.mjs registers ${registered.length} scripts, gen-ports.mjs lists ${expected.length}`);
        failures++;
    }

    for (const base of list) {
        // eslint-disable-next-line no-await-in-loop
        const d = await checkPort(
            path.join(ROOT, `nethack-c/recorder/dat/${base}.lua`),
            path.join(ROOT, `js/lua-js/scripts/${tier}/${base}.mjs`),
        );
        if (d) { console.error(`FAIL ${base}.mjs differs from ${base}.lua at ${d}`); failures++; }
        checked++;
    }
}

// A script may not be registered twice: the registry merges the tiers into one
// map and a duplicate key would silently drop one of them.
const all = [...T0, ...T1, ...T2, ...T3];
if (new Set(all).size !== all.length) {
    console.error('FAIL a script appears in more than one tier');
    failures++;
}

if (failures) {
    console.error(`lua-port-scripts: ${failures} failure(s)`);
    process.exit(1);
}
console.log(`lua-port-scripts: ${checked} script transcriptions verified`);
