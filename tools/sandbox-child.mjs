#!/usr/bin/env node
// sandbox-child.mjs — run one session's runSegment() calls and print
// the captured outputs as JSON on stdout. Used two ways:
//
//   - spawned by tools/strict-score.mjs under `node --permission`
//     (judge-style sandbox), and
//   - imported directly for the unsandboxed reference run.
//
// Comparing the two proves our js/ code behaves identically inside the
// judge's isolation — it doesn't secretly depend on fs/net/subprocess.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export async function runSessionCollect(sessionPath) {
    const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const { normalizeSession } = await import(join(ROOT, 'frozen/session_loader.mjs'));
    const { runSegment } = await import(join(ROOT, 'js/jsmain.js'));
    const segments = normalizeSession(sessionData).segments;

    const storage = new Map();
    const storageHandle = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, String(v)); },
        removeItem: (k) => { storage.delete(k); },
        get length() { return storage.size; },
        key(i) { let n = 0; for (const k of storage.keys()) { if (n++ === i) return k; } return null; },
    };

    const out = { screens: [], rng: [], cursors: [] };
    for (const seg of segments) {
        const game = await runSegment({
            seed: seg.seed, datetime: seg.datetime,
            nethackrc: seg.nethackrc, moves: seg.moves,
            storage: storageHandle,
        });
        // Element-wise, not push(...arr): a long session's RNG log runs to
        // six figures and blows the argument limit (seed0360 draws 120k).
        for (const s of game.getScreens?.() || []) out.screens.push(s);
        for (const r of game.getRngLog?.() || []) out.rng.push(r);
        for (const c of game.getCursors?.() || []) out.cursors.push(c);
    }
    return out;
}

// CLI mode: node sandbox-child.mjs <session.json> → JSON on stdout
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const sessionPath = process.argv[2];
    if (!sessionPath) {
        console.error('Usage: node tools/sandbox-child.mjs <session.json>');
        process.exit(2);
    }
    try {
        const out = await runSessionCollect(sessionPath);
        process.stdout.write(JSON.stringify(out));
    } catch (e) {
        console.error(`sandbox-child error: ${e.message}`);
        process.exit(1);
    }
}
