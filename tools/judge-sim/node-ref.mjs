// node-ref.mjs — the Node side of the browser/Node equivalence check.
//
// Runs a session through js/jsmain.js exactly the way frozen/ps_test_runner.mjs
// does and prints the same per-segment digests tools/judge-sim/driver.html
// computes in the browser. Equal digests ⇒ the browser's runSegment output is
// byte-identical to Node's ⇒ the browser scores what Node scores.
//
// Usage: node tools/judge-sim/node-ref.mjs <session.json name> [> ref.json]

import { createHash } from 'node:crypto';
import { normalizeSession } from '../../frozen/session_loader.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = process.argv[2] || 'seed8000-tourist-starter.session.json';

function findSession(n) {
    for (const dir of ['sessions', 'sessions-extra', 'sessions-landmine']) {
        const p = path.join(ROOT, dir, n);
        if (fs.existsSync(p)) return p;
    }
    throw new Error('no such session: ' + n);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function digestSegment(game) {
    const screens = game.getScreens?.() || [];
    const cursors = game.getCursors?.() || [];
    const rng = game.getRngLog?.() || [];
    const anim = game.getAnimationFramesByStep?.() || [];
    return {
        screens: screens.length,
        cursors: cursors.length,
        rng: rng.length,
        animSteps: anim.length,
        screensSha: sha256(JSON.stringify(screens)),
        cursorsSha: sha256(JSON.stringify(cursors)),
        rngSha: sha256(JSON.stringify(rng)),
        rngHead: rng.slice(0, 3),
        rngTail: rng.slice(-3),
    };
}

const { runSegment } = await import(path.join(ROOT, 'js/jsmain.js'));
const segments = normalizeSession(JSON.parse(fs.readFileSync(findSession(name), 'utf8'))).segments;

const storage = new Map();
const storageHandle = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
    get length() { return storage.size; },
    key(i) { let n = 0; for (const k of storage.keys()) { if (n === i) return k; n++; } return null; },
};

const report = { session: name, node: process.versions.node, segments: [], ok: true, error: null };
try {
    for (const seg of segments) {
        const t = Date.now();
        const game = await runSegment({
            seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc,
            moves: seg.moves, storage: storageHandle,
        });
        const d = digestSegment(game);
        d.ms = Date.now() - t;
        report.segments.push(d);
        process.stderr.write(`  segment ${report.segments.length}/${segments.length}: screens=${d.screens} rng=${d.rng} (${d.ms} ms)\n`);
    }
} catch (e) {
    report.ok = false;
    report.error = String(e && e.stack || e);
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
