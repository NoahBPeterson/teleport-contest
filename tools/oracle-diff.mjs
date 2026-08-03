#!/usr/bin/env node
// oracle-diff.mjs — Hidden-state first-divergence comparator.
//
// Compares the C recorder's per-step hidden-state dumps (steps[].state,
// captured with TELEPORT_RECORD_STATE=1) against the JS port's dumps
// (TELEPORT_STATE_DUMP=1, see js/statedump.js), and reports the FIRST
// field that disagrees: step, JSON path, C value, JS value. This is the
// leading indicator of port bugs; screen divergence is the trailing one.
//
// Technique credit: Owen Lockwood's "oracle" (David Bau,
// "Hunting Zombies", 2026-07-16).
//
// Usage:
//   TELEPORT_RECORD_STATE=1 node scripts/record-session.mjs <in> <out>   # capture C state
//   node tools/oracle-diff.mjs <out.session.json>                        # compare
//   node tools/oracle-diff.mjs --selftest                                # validate comparator

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TOOLS_DIR, '..');

/**
 * Find the first leaf difference between two JSON-ish values.
 * Arrays compare index-wise (chain order is semantics: fmon order
 * drives monster scheduling). Object key sets must match exactly.
 *
 * @param {*} c - C-side value
 * @param {*} j - JS-side value
 * @param {string} path - accumulated JSON path
 * @returns {{path: string, c: *, j: *} | null}
 */
export function firstFieldDiff(c, j, path = '$') {
    if (c === null || c === undefined || j === null || j === undefined
        || typeof c !== 'object' || typeof j !== 'object') {
        // Numeric tolerance: none. Bit-exact or it diverges.
        return c === j ? null : { path, c, j };
    }
    if (Array.isArray(c) !== Array.isArray(j)) return { path, c, j };
    if (Array.isArray(c)) {
        const n = Math.min(c.length, j.length);
        for (let i = 0; i < n; i++) {
            const d = firstFieldDiff(c[i], j[i], `${path}[${i}]`);
            if (d) return d;
        }
        if (c.length !== j.length) {
            return { path: `${path}.length`, c: c.length, j: j.length };
        }
        return null;
    }
    const cKeys = Object.keys(c);
    const jKeys = new Set(Object.keys(j));
    for (const k of cKeys) jKeys.delete(k);
    if (jKeys.size) return { path: `${path}.{missing-in-C keys: ${[...jKeys]}`, c: undefined, j: true };
    for (const k of cKeys) {
        if (!(k in j)) return { path: `${path}.${k}`, c: c[k], j: undefined };
        const d = firstFieldDiff(c[k], j[k], `${path}.${k}`);
        if (d) return d;
    }
    return null;
}

function selftest() {
    const base = {
        moves: 10, dnum: 0, dlevel: 1,
        hero: { x: 5, y: 6, hp: 11, hpmax: 11 },
        mons: [
            { id: 1, pm: 100, hp: 8, hpmax: 8, tame: 10 },
            { id: 2, pm: 57, hp: 2, hpmax: 2, tame: 0 },
        ],
        inv: [],
    };
    // Case 1: identical → no diff
    console.assert(firstFieldDiff(base, JSON.parse(JSON.stringify(base))) === null,
        'selftest 1 failed: identical states must not diff');
    // Case 2: the Hunting Zombies bug — zombie removed at 2/2 hp instead
    // of killed at 0/2; pony never grows (hpmax 7, not 8).
    const zomb = JSON.parse(JSON.stringify(base));
    const cSide = JSON.parse(JSON.stringify(base));
    cSide.hero.hp = 11;
    cSide.mons[0].hpmax = 9; // pony grew in C
    zomb.mons[1].hp = 2;     // JS removed zombie without damage
    const d = firstFieldDiff(cSide, zomb);
    console.assert(d && d.path === '$.mons[0].hpmax' && d.c === 9 && d.j === 8,
        `selftest 2 failed: ${JSON.stringify(d)}`);
    // Case 3: chain-order (fmon newest-first vs appended) detected
    const rev = JSON.parse(JSON.stringify(base));
    rev.mons.reverse();
    const d3 = firstFieldDiff(base, rev);
    console.assert(d3 && d3.path.startsWith('$.mons[0]'), `selftest 3 failed: ${JSON.stringify(d3)}`);
    console.log('selftest OK');
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === '--selftest') { selftest(); return; }
    const sessionPath = argv[0];
    if (!sessionPath) {
        console.error('Usage: node tools/oracle-diff.mjs <session-with-state.json> | --selftest');
        process.exit(2);
    }

    const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const { normalizeSession } = await import(join(PROJECT_ROOT, 'frozen/session_loader.mjs'));
    const segments = normalizeSession(sessionData).segments;

    // Flatten C-side per-step state.
    const cStates = [];
    for (const seg of segments) {
        for (const step of seg.steps || []) cStates.push(step.state ?? null);
    }
    if (cStates.every((s) => s === null)) {
        console.error('This session has no steps[].state. Re-record it with:');
        console.error('  TELEPORT_RECORD_STATE=1 node scripts/record-session.mjs <in> <out>');
        process.exit(2);
    }

    // Run the JS port with state dumping enabled.
    process.env.TELEPORT_STATE_DUMP = '1';
    const { runSegment } = await import(join(PROJECT_ROOT, 'js/jsmain.js'));
    const storage = new Map();
    const storageHandle = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, String(v)); },
        removeItem: (k) => { storage.delete(k); },
        get length() { return storage.size; },
        key(i) { let n = 0; for (const k of storage.keys()) { if (n++ === i) return k; } return null; },
    };
    const jStates = [];
    let jsError = null;
    try {
        for (const seg of segments) {
            const game = await runSegment({
                seed: seg.seed, datetime: seg.datetime,
                nethackrc: seg.nethackrc, moves: seg.moves,
                storage: storageHandle,
            });
            jStates.push(...(game.getStateDumps?.() || []));
        }
    } catch (e) {
        jsError = e.message;
    }

    console.log(`session: ${sessionPath}`);
    console.log(`C steps with state: ${cStates.filter(Boolean).length}/${cStates.length}   JS dumps: ${jStates.length}`);
    if (jsError) console.log(`JS error: ${jsError}`);

    const n = Math.min(cStates.length, jStates.length);
    let matchedSteps = 0;
    for (let i = 0; i < n; i++) {
        if (!cStates[i]) { matchedSteps++; continue; }
        const d = firstFieldDiff(cStates[i], jStates[i]);
        if (!d) { matchedSteps++; continue; }
        console.log(`\nFirst state divergence at step ${i} (of ${n}):`);
        console.log(`  path: ${d.path}`);
        console.log(`  C  : ${JSON.stringify(d.c)}`);
        console.log(`  JS : ${JSON.stringify(d.j)}`);
        console.log(`\nState-matched steps: ${matchedSteps}/${n}`);
        process.exit(1);
    }
    if (cStates.length !== jStates.length) {
        console.log(`\nStep-count mismatch: C ${cStates.length} vs JS ${jStates.length}`);
        process.exit(1);
    }
    console.log(`\nSTATE: FULL MATCH (${matchedSteps}/${cStates.length} steps)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
