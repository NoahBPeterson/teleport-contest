/**
 * The transcription check for the 49 T0 level-script ports.
 *
 * js/lua-js/scripts/t0/*.mjs are generated from nethack-c/recorder/dat/*.lua
 * by tools/lua-port-gen/lua2des.mjs. Once committed they are ordinary source:
 * reviewers diff them, and a 5.1 update will edit them. This test re-parses
 * each .lua, evaluates the des.* call stream it describes, runs the committed
 * module against a recording stub, and requires the two streams to be equal —
 * every call, every argument, every table key, in order.
 *
 * It is a source-vs-source check and needs no game, which is what makes it
 * cheap enough to run on every `node --test`. What it protects against is the
 * whole class of error the generator exists to avoid:
 *
 *   * a hand-edit to a generated module that quietly changes a coordinate;
 *   * an editor or formatter stripping the trailing spaces off a `des.map`
 *     template literal — 21 of the 34 maps have them, and they are load-bearing;
 *   * a .lua updated without regenerating its port.
 *
 * It does *not* prove the port produces the same level: that is the differential
 * oracle's job (tools/lua-oracle.mjs, and NOTES-lua-port.md §7.7's evidence
 * table). This proves the port says what the .lua says.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPort } from '../tools/lua-port-gen/lua2des.mjs';
import { T0 } from '../tools/lua-port-gen/gen-t0.mjs';
import { T0_PORTS } from '../js/lua-js/scripts/t0/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

// The index the registry loads from must list exactly the tier, in order: a
// port that exists on disk but is not registered would never run, and one
// registered but missing would throw at boot.
const registered = [...T0_PORTS.keys()];
const expected = T0.map((b) => `${b}.lua`);
if (registered.length !== expected.length || registered.some((k, i) => k !== expected[i])) {
    console.error(`FAIL t0/index.mjs registers ${registered.length} scripts, gen-t0.mjs lists ${expected.length}`);
    failures++;
}

for (const base of T0) {
    // eslint-disable-next-line no-await-in-loop
    const d = await checkPort(
        path.join(ROOT, `nethack-c/recorder/dat/${base}.lua`),
        path.join(ROOT, `js/lua-js/scripts/t0/${base}.mjs`),
    );
    if (d) { console.error(`FAIL ${base}.mjs differs from ${base}.lua at ${d}`); failures++; }
}

if (failures) {
    console.error(`lua-port-scripts: ${failures} failure(s)`);
    process.exit(1);
}
console.log(`lua-port-scripts: ${T0.length} T0 level-script transcriptions verified`);
