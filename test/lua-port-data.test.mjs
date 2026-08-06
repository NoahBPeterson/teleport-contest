/**
 * The transcription check for the two pure-data Lua ports.
 *
 * js/lua-js/data/dungeon.mjs and js/lua-js/data/quest.mjs are generated from
 * nethack-c/recorder/dat/*.lua by tools/lua-port-gen/lua2js.mjs. Once
 * committed they are ordinary source: reviewers diff them, and a 5.1 update
 * will edit them. This test re-parses the .lua and requires the committed
 * modules to still be exactly the value it describes — same values, same keys,
 * *same key order*, because key order is what fixes the Lua table's array/hash
 * layout and therefore the lua_next order init_dungeons() walks.
 *
 * It is a source-vs-source check and needs no game: fast enough to run every
 * time, and it fails loudly if someone hand-edits a generated data module or
 * updates the .lua without regenerating.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, plain, diff } from '../tools/lua-port-gen/lua2js.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
    { lua: 'nethack-c/recorder/dat/dungeon.lua', global: 'dungeon', mod: 'js/lua-js/data/dungeon.mjs' },
    { lua: 'nethack-c/recorder/dat/quest.lua', global: 'questtext', mod: 'js/lua-js/data/quest.mjs' },
];

let failures = 0;

for (const c of CASES) {
    const globals = parse(fs.readFileSync(path.join(ROOT, c.lua), 'utf8'));
    if (globals.length !== 1 || globals[0].name !== c.global) {
        console.error(`FAIL ${c.lua}: expected exactly one global named ${c.global}, `
            + `got ${globals.map((g) => g.name).join(', ')}`);
        failures++;
        continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const mod = await import(path.join(ROOT, c.mod));
    const d = diff(plain(globals[0].value), mod.default);
    if (d) { console.error(`FAIL ${c.mod} differs from ${c.lua} at ${d}`); failures++; }
}

// The layout contract the bridge relies on: every table is either a pure
// sequence or a pure record, never both. A mixed table would need its array
// part and hash part sized separately in lua_createtable(), which the plain
// JS array/object representation cannot express.
function checkShape(v, where) {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
        v.forEach((e, i) => checkShape(e, `${where}[${i}]`));
        return;
    }
    for (const k of Object.keys(v)) {
        if (/^\d+$/.test(k)) { console.error(`FAIL ${where}: integer key ${k} in a record table`); failures++; }
        checkShape(v[k], `${where}.${k}`);
    }
}
for (const c of CASES) {
    // eslint-disable-next-line no-await-in-loop
    checkShape((await import(path.join(ROOT, c.mod))).default, c.global);
}

if (failures) {
    console.error(`lua-port-data: ${failures} failure(s)`);
    process.exit(1);
}
console.log('lua-port-data: dungeon.lua and quest.lua transcriptions verified');
