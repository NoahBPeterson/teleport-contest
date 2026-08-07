/**
 * The transcription check for the generated level-script ports.
 *
 * js/lua-js/scripts/t0/*.mjs are generated from nethack-c/recorder/dat/*.lua
 * by tools/lua-port-gen/lua2des.mjs. Once committed they are ordinary source:
 * reviewers diff them, and a 5.1 update will edit them. This test re-parses
 * each .lua, evaluates the call stream it describes, runs the committed module
 * against a recording stub, and requires the two streams to be equal — every
 * call, every argument, every table key, in order.
 *
 * Both sides are driven by the *same* deterministic RNG object and the same
 * copy of nhlib's percent/shuffle/math.random (js/lua-js/nhlib.mjs), so once a
 * tier has scripts that spend draws of their own the comparison pins those too.
 * checkPort() runs several RNG settings including one that forces every
 * percent() true and one that forces every percent() false, so both arms of
 * every branch are checked rather than whichever one a draw happened to pick.
 *
 * It is a source-vs-source check and needs no game, which is what makes it
 * cheap enough to run on every `node --test`. What it protects against is the
 * whole class of error the generator exists to avoid:
 *
 *   * a hand-edit to a generated module that quietly changes a coordinate;
 *   * an editor or formatter stripping the trailing spaces off a `des.map`
 *     template literal — 21 of the 34 maps have them, and they are
 *     load-bearing;
 *   * a .lua updated without regenerating its port.
 *
 * It does *not* prove the port produces the same level: that is the differential
 * oracle's job (tools/lua-oracle.mjs, and NOTES-lua-port.md §7.7's evidence
 * table). This proves the port says what the .lua says.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPort } from '../tools/lua-port-gen/lua2des.mjs';
import { T0 } from '../tools/lua-port-gen/gen-ports.mjs';
import { T0_PORTS } from '../js/lua-js/scripts/t0/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIERS = [
    { tier: 't0', list: T0, ports: T0_PORTS },
];

let failures = 0;
let checked = 0;

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
const all = [...T0];
if (new Set(all).size !== all.length) {
    console.error('FAIL a script appears in more than one tier');
    failures++;
}

if (failures) {
    console.error(`lua-port-scripts: ${failures} failure(s)`);
    process.exit(1);
}
console.log(`lua-port-scripts: ${checked} level-script transcriptions verified`);
