#!/usr/bin/env node
// gen-ports.mjs — regenerate every generated level-script port, and the index
// modules registry.mjs registers them from.
//
// Two tiers so far, both driven by tools/lua-port-gen/lua2des.mjs:
//
//   T0 — pure declarative. Comments stripped, `functions + if + for + while +
//        percent + shuffle + math.random + nh.rn2` is zero (stage S2, §7).
//   T1 — the same, plus `if percent(…)`, `shuffle` over a literal table,
//        `math.random`, and `contents`/`inventory` closures; still no loops,
//        no selection algebra (`|`/`&`/`~`), no nhlib helper beyond those
//        (stage S3, §11).
//
// Both lists are explicit and reviewable rather than rediscovered by a
// heuristic at runtime — but they are also *checked*, in the sense that the
// generator refuses anything outside its subset, so "it generated" is itself
// evidence that a script belongs to the tier it is listed in.
//
// Usage:
//   node tools/lua-port-gen/gen-ports.mjs            # regenerate
//   node tools/lua-port-gen/gen-ports.mjs --check    # verify, change nothing

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPort, emitModule, fnName, parse } from './lua2des.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAT = path.join(ROOT, 'nethack-c/recorder/dat');

/** Grouped the way §7 tells the stage: quest branches, then the rest. */
export const T0 = [
    // The 34 quest levels that are pure call streams. Every role's -goal (the
    // nemesis level) and -loca (the locate level) and, for eight roles, the
    // two -fil filler levels.
    'Arc-goal', 'Arc-loca',
    'Bar-fila', 'Bar-filb', 'Bar-goal', 'Bar-loca',
    'Cav-fila', 'Cav-filb', 'Cav-goal', 'Cav-loca',
    'Hea-fila', 'Hea-filb', 'Hea-goal', 'Hea-loca',
    'Kni-fila', 'Kni-filb', 'Kni-goal', 'Kni-loca',
    'Mon-loca',
    'Pri-loca',
    'Ran-fila', 'Ran-filb', 'Ran-goal', 'Ran-loca',
    'Rog-goal', 'Rog-loca',
    'Sam-fila', 'Sam-filb', 'Sam-loca',
    'Tou-fila', 'Tou-filb',
    'Val-fila', 'Val-filb', 'Val-loca',
    'Wiz-goal',
    // Sokoban: the six levels whose layout is entirely fixed.
    'soko2-1', 'soko2-2', 'soko3-1', 'soko3-2', 'soko4-1', 'soko4-2',
    // The Elemental Planes.
    'air', 'earth', 'fire', 'water',
    // One-offs.
    'baalz',      // Gehennom: Baalzebub's lair
    'minetn-6',   // one of the seven Mine Town variants
    'tower3',     // the top of Vlad's Tower
    'tut-2',      // the second tutorial level
];

/**
 * Stage S3's tier: the same declarative surface plus branches, shuffles and
 * closures. §11 has the per-script evidence and the reasons the rest of the
 * mechanically-similar scripts are not here (they need loops, selection
 * algebra, or nhlib's hell_tweaks()).
 */
export const T1 = [
    // The ten quest filler levels whose whole body is `des.room{contents=…}`.
    'Arc-fila', 'Arc-filb',
    'Mon-fila', 'Mon-filb',
    'Pri-fila', 'Pri-filb',
    'Rog-fila', 'Rog-filb',
    'Wiz-fila', 'Wiz-filb',
    // The seven quest home levels that are a call stream plus one `inventory`
    // closure on the class leader. (The other six -strt levels have a `for`.)
    'Arc-strt', 'Cav-strt', 'Hea-strt', 'Ran-strt', 'Sam-strt', 'Tou-strt', 'Wiz-strt',
    // Three quest nemesis levels that pick a spot with math.random.
    'Mon-goal', 'Pri-goal', 'Sam-goal',
    // Sokoban level 1: one `if percent(…)` choosing the prize.
    'soko1-1', 'soko1-2',
    // The Mines' end levels: two shuffle a niche list, one branches.
    'minend-1', 'minend-2', 'minend-3',
    // One-offs.
    'castle',     // two shuffles, a selection of four towers, one closure
    'juiblex',    // Gehennom: Juiblex's swamp; shuffles its monster classes
    'sanctum',    // Gehennom: Moloch's sanctum; one closure inside a region
];

/** @returns {{tier: string, dir: string, list: string[]}[]} */
function tiers() {
    return [
        { tier: 't0', dir: path.join(ROOT, 'js/lua-js/scripts/t0'), list: T0, label: 'pure-declarative' },
        { tier: 't1', dir: path.join(ROOT, 'js/lua-js/scripts/t1'), list: T1, label: 'branch/shuffle/closure' },
    ];
}

function generate(t, check) {
    fs.mkdirSync(t.dir, { recursive: true });
    let bad = 0;
    for (const base of t.list) {
        const luaPath = path.join(DAT, `${base}.lua`);
        const outPath = path.join(t.dir, `${base}.mjs`);
        const text = emitModule(parse(fs.readFileSync(luaPath, 'utf8')), base);
        if (check) {
            const have = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
            if (have !== text) { process.stderr.write(`gen-ports: STALE ${t.tier}/${base}.mjs\n`); bad++; }
        } else {
            fs.writeFileSync(outPath, text);
        }
    }
    return bad;
}

/** The index module registry.mjs registers a whole tier from. */
function index(t) {
    const upper = t.tier.toUpperCase();
    const lines = [
        `// ${t.tier}/index.mjs — the ${t.list.length} ${t.label} level scripts, as one map.`,
        '//',
        '// GENERATED by tools/lua-port-gen/gen-ports.mjs alongside the modules it lists.',
        '// Keyed by the filename nhl_loadlua() is handed, which is what',
        '// js/lua-js/registry.mjs matches on.',
        '',
    ];
    for (const b of t.list) lines.push(`import ${fnName(b)} from './${b}.mjs';`);
    lines.push('');
    lines.push('/** @type {Map<string, (api: object) => void>} */');
    lines.push(`export const ${upper}_PORTS = new Map([`);
    for (const b of t.list) lines.push(`    ['${b}.lua', ${fnName(b)}],`);
    lines.push(']);');
    lines.push('');
    return lines.join('\n');
}

async function main(argv) {
    const check = argv.includes('--check');
    let bad = 0;
    let count = 0;
    for (const t of tiers()) {
        bad += generate(t, check);
        const idxPath = path.join(t.dir, 'index.mjs');
        const idx = index(t);
        if (check) {
            if (!fs.existsSync(idxPath) || fs.readFileSync(idxPath, 'utf8') !== idx) {
                process.stderr.write(`gen-ports: STALE ${t.tier}/index.mjs\n`);
                bad++;
            }
        } else {
            fs.writeFileSync(idxPath, idx);
        }
        // Whether it regenerated or verified, prove every module still
        // produces the .lua's call stream, under every --check RNG setting.
        for (const base of t.list) {
            // eslint-disable-next-line no-await-in-loop
            const d = await checkPort(path.join(DAT, `${base}.lua`), path.join(t.dir, `${base}.mjs`));
            if (d) { process.stderr.write(`gen-ports: CALL-STREAM FAIL ${base}: ${d}\n`); bad++; }
        }
        count += t.list.length;
    }
    process.stderr.write(`gen-ports: ${count} scripts, ${bad ? `${bad} PROBLEMS` : 'all clean'}\n`);
    process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
