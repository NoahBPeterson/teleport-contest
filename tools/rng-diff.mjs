#!/usr/bin/env node
// rng-diff.mjs — Positional PRNG divergence reporter.
//
// Runs the JS port (js/jsmain.js runSegment) against a recorded session
// and reports the FIRST RNG call where the JS port diverges from the C
// recording, with the C-side caller annotation (file:line) that the
// scorer strips, plus surrounding context. This is the first tool to
// reach for when a session fails: PRNG divergence precedes screen
// divergence, and the first mismatch is the one worth fixing.
//
// Usage:
//   node tools/rng-diff.mjs <session.json> [--context N] [--tail N]
//
// Example:
//   node tools/rng-diff.mjs sessions/seed8000-tourist-starter.session.json

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TOOLS_DIR, '..');

// --- same normalization as frozen/ps_test_runner.mjs -----------------------
function isRngCall(entry) {
    return typeof entry === 'string' && /^(?:rn2|rnd|rn1|rnl|rne|rnz|d)\(/.test(entry);
}
function normalizeRng(entry) {
    return entry.replace(/\s*@\s.*$/, '').replace(/^\d+\s+/, '').trim();
}

function parseArgs(argv) {
    const opts = { context: 4, tail: 6, session: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--context') opts.context = Number(argv[++i]);
        else if (argv[i] === '--tail') opts.tail = Number(argv[++i]);
        else if (!argv[i].startsWith('--')) opts.session = argv[i];
    }
    if (!opts.session) {
        console.error('Usage: node tools/rng-diff.mjs <session.json> [--context N] [--tail N]');
        process.exit(2);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const sessionData = JSON.parse(readFileSync(opts.session, 'utf8'));
    const { normalizeSession } = await import(join(PROJECT_ROOT, 'frozen/session_loader.mjs'));
    const { runSegment } = await import(join(PROJECT_ROOT, 'js/jsmain.js'));
    const segments = normalizeSession(sessionData).segments;

    // Flatten C-side RNG, remembering which step each call belongs to.
    const cCalls = []; // { norm, raw, step, key, seg }
    for (let si = 0; si < segments.length; si++) {
        const steps = segments[si].steps || [];
        for (let ti = 0; ti < steps.length; ti++) {
            for (const raw of (steps[ti].rng || []).filter(isRngCall)) {
                cCalls.push({ norm: normalizeRng(raw), raw, step: ti, key: steps[ti].key, seg: si });
            }
        }
    }

    // Run the JS port, mirroring the scorer's harness (shared storage map).
    const storage = new Map();
    const storageHandle = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, String(v)); },
        removeItem: (k) => { storage.delete(k); },
        get length() { return storage.size; },
        key(i) { let n = 0; for (const k of storage.keys()) { if (n++ === i) return k; } return null; },
    };
    const jsCalls = [];
    let jsError = null;
    try {
        for (const seg of segments) {
            const input = {
                seed: seg.seed,
                datetime: seg.datetime,
                nethackrc: seg.nethackrc,
                moves: seg.moves,
                storage: storageHandle,
            };
            const game = await runSegment(input);
            const log = (game.getRngLog?.() || [])
                .map((e) => (typeof e === 'string' ? e.replace(/^\d+\s+/, '') : String(e)))
                .filter(isRngCall);
            for (const e of log) jsCalls.push(normalizeRng(e));
        }
    } catch (e) {
        jsError = e.stack || e.message;
    }

    // Positional comparison.
    const total = cCalls.length;
    let firstDiv = -1;
    const limit = Math.max(total, jsCalls.length);
    for (let i = 0; i < limit; i++) {
        const c = cCalls[i] ? cCalls[i].norm : '<missing>';
        const j = i < jsCalls.length ? jsCalls[i] : '<missing>';
        if (c !== j) { firstDiv = i; break; }
    }

    console.log(`session: ${opts.session}`);
    console.log(`C calls: ${total}   JS calls: ${jsCalls.length}`);
    if (jsError) console.log(`JS error: ${jsError.split('\n')[0]}`);

    if (firstDiv === -1) {
        console.log(total === jsCalls.length
            ? 'RNG: FULL MATCH'
            : `RNG: prefix match but length differs (C ${total} vs JS ${jsCalls.length})`);
        return;
    }

    const c = cCalls[firstDiv];
    console.log(`\nFirst divergence at call #${firstDiv}`
        + (c ? ` (seg ${c.seg}, step ${c.step}, key ${JSON.stringify(c.key)})` : ' (past end of C log)'));
    console.log(`  C : ${c ? c.raw : '<missing>'}`);
    console.log(`  JS: ${firstDiv < jsCalls.length ? jsCalls[firstDiv] : '<missing>'}`);

    const lo = Math.max(0, firstDiv - opts.context);
    console.log(`\ncontext (matched calls ${lo}..${firstDiv - 1}):`);
    for (let i = lo; i < firstDiv; i++) {
        console.log(`  #${i}  ${cCalls[i].raw}`);
    }
    console.log('following C calls:');
    for (let i = firstDiv; i < Math.min(total, firstDiv + opts.tail); i++) {
        console.log(`  #${i}  ${cCalls[i].raw}${i === firstDiv ? '   <-- diverges here' : ''}`);
    }
    console.log('following JS calls:');
    for (let i = firstDiv; i < Math.min(jsCalls.length, firstDiv + opts.tail); i++) {
        console.log(`  #${i}  ${jsCalls[i]}${i === firstDiv ? '   <-- diverges here' : ''}`);
    }

    const matched = firstDiv;
    console.log(`\nRNG matched: ${matched}/${total} (${(100 * matched / Math.max(1, total)).toFixed(1)}%)`);
    process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
