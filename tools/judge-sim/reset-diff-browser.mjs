// reset-diff-browser.mjs — the browser reset differential, driven end to end.
//
//   node tools/judge-sim/reset-diff-browser.mjs [--pairs A:B,...] [--noop]
//                                              [--timeout ms] [--json out.json]
//
// tools/reset-diff.mjs proves in Node that resetting the transpiled module
// graph is indistinguishable from forking a fresh one. It is a Node tool
// because its REFERENCE — a genuinely fresh graph per segment — comes from
// module.registerHooks, and docs/NOTES-resettable-state.md §7.6 deferred the
// browser for exactly that reason: switching a page to the reset would have
// meant shipping the one part of this design that rests on measurement, without
// the measurement.
//
// The reason was wrong. A module Worker is a fresh realm with a fresh module
// map, so a page CAN produce a genuinely fresh graph per segment — that is
// precisely what js/boot/frame.mjs does and what js/jsmain.js used for every
// browser segment before this leg. So the reference exists in a page, built out
// of the mechanism the reset replaces.
//
// This file is the harness around tools/judge-sim/reset-diff.html: the same
// mirror-shaped server the rest of this directory uses (js/** and frozen/**
// only, every request logged), real headless Chrome, the page's report read
// back off /__sim/result.
//
// WHAT MAKES A PASS MEAN ANYTHING. Two things, and neither is optional:
//
//   --noop        patches Realm.prototype.reset to a no-op that reports
//                 success, exactly as tools/reset-diff.mjs's --force-noop does.
//                 EVERY pair must then FAIL; the run's exit code is inverted so
//                 that "all failed" is success. A harness that cannot fail on a
//                 deliberately broken reset is not evidence of anything.
//   test workers  if the page realm could not be owned, runSegment falls back
//                 to a Worker per segment — and both sides of the differential
//                 would then be the reference, passing while testing nothing.
//                 The page counts every `new Worker` and attributes it; a test
//                 side that built any is a FAIL here, whatever the digests say.
//
// Chrome is located at the macOS default; override with CHROME=/path/to/chrome.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSION_DIRS = ['sessions', 'sessions-extra'];

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const pre = '--' + name + '=';
    const hit = args.find((a) => a.startsWith(pre));
    if (hit) return hit.slice(pre.length);
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const noop = args.includes('--noop');
const timeoutMs = Number(opt('timeout', '900000'));
const jsonOut = opt('json', '');
const PORT = Number(opt('port', String(9300 + (process.pid % 200))));

// The default pair set, matched to tools/reset-diff.mjs's so the two
// differentials are answering the same question about the same sessions. Nine
// pairs: a self-pair (the weakest possible reset still has to survive it),
// cross-role and cross-length, and BOTH acid tests — seed0013 (save then
// restore, 2 segments) and seed0030 (ten segments), the only sessions where a
// reset has to stand in for a fork *inside* one session — each of them paired
// against itself and against another.
const DEFAULT_PAIRS = [
    ['seed8000', 'seed8000'],            // self-pair: the floor
    ['seed8000', 'seed4500'],            // short then long
    ['seed0002', 'seed0006'],            // healer -> wizard
    ['seed0006', 'seed0002'],            // and back
    ['seed0004', 'seed0007'],            // pony -> rogue/swamp
    ['seed0007', 'seed0013-friday13'],   // -> acid test 1 (save/restore)
    ['seed0013-friday13', 'seed0013-friday13'],   // acid test 1, self-paired
    ['seed8000', 'seed0030'],            // -> acid test 2 (ten segments)
    ['seed0030', 'seed0030'],            // acid test 2, self-paired
    ['seed0013-friday13', 'seed0030'],   // both acid tests, back to back
];

// ---- sessions -------------------------------------------------------------
function discoverSessions() {
    const out = new Map();
    for (const d of SESSION_DIRS) {
        let names;
        try { names = fs.readdirSync(path.join(ROOT, d)); } catch { continue; }
        for (const f of names) if (f.endsWith('.session.json')) out.set(f.replace(/\.session\.json$/, ''), f);
    }
    return out;
}
function resolveSession(all, spec) {
    if (all.has(spec)) return all.get(spec);
    const hits = [...all.keys()].filter((k) => k.startsWith(spec));
    if (hits.length === 1) return all.get(hits[0]);
    if (hits.length === 0) throw new Error(`no session matches "${spec}"`);
    throw new Error(`"${spec}" is ambiguous: ${hits.join(', ')}`);
}

const all = discoverSessions();
const wanted = opt('pairs', '')
    ? opt('pairs', '').split(',').map((p) => { const [a, b] = p.split(':'); return [a.trim(), b.trim()]; })
    : DEFAULT_PAIRS;
const pairs = wanted.map(([a, b]) => [resolveSession(all, a), resolveSession(all, b)]);

// ---- server + browser -----------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-diff-browser-'));
const logFile = path.join(work, 'requests.jsonl');
const resultFile = path.join(work, 'report.json');
const chromeProfile = path.join(work, 'chrome-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'),
    '--port', String(PORT), '--log', logFile, '--result', resultFile],
    { stdio: ['ignore', 'inherit', 'inherit'] });

let up = false;
for (let i = 0; i < 100 && !up; i++) {
    await sleep(50);
    try { await fetch(`http://127.0.0.1:${PORT}/js/jsmain.js`); up = true; } catch { /* not yet */ }
}
if (!up) { server.kill(); throw new Error('server never came up'); }

const url = `http://127.0.0.1:${PORT}/__sim/reset-diff.html?pairs=`
    + encodeURIComponent(pairs.map(([a, b]) => a + ':' + b).join(',')) + (noop ? '&noop=1' : '');

process.stderr.write(`\n=== Browser reset differential${noop ? ' (--noop RED CONTROL)' : ''} ===\n`);
process.stderr.write(`  ${pairs.length} pair(s), reference = one js/boot/frame.mjs Worker realm per segment\n`);
process.stderr.write(`  ${url}\n`);

const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${chromeProfile}`, '--enable-logging=stderr', '--v=0',
    // The page realm holds ONE graph and resets it; the reference workers are
    // terminated as they finish. Neither accumulates, but seed0030 is ten
    // segments of level generation and the default heap is not generous.
    '--js-flags=--max-old-space-size=4096',
    url,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });
chrome.stdout.on('data', (d) => { chromeErr += d; });
// The page narrates itself with console.log('[resetdiff] …'); echo it so a long
// run shows progress instead of looking hung.
chrome.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
        const m = line.match(/"\[resetdiff\] (.*)", source:/);
        if (m) process.stderr.write('  ' + m[1] + '\n');
    }
});

const deadline = Date.now() + timeoutMs;
while (!fs.existsSync(resultFile) && Date.now() < deadline) await sleep(250);
const timedOut = !fs.existsSync(resultFile);
chrome.kill();
await sleep(200);
server.kill('SIGINT');
await sleep(300);

if (timedOut) {
    process.stderr.write('\nFAIL: the page never posted a report. Chrome stderr tail:\n');
    process.stderr.write(chromeErr.slice(-4000) + '\n');
    process.exit(1);
}

const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const reqs = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const blocked = reqs.filter((r) => r.kind === 'BLOCKED');

// ---- verdict --------------------------------------------------------------
const rows = report.pairs || [];
const failures = rows.filter((r) => r.verdict !== 'PASS').length;
const w = Math.max(4, ...rows.map((r) => r.label.length));

process.stderr.write('\n' + 'pair'.padEnd(w) + '  verdict\n' + '-'.repeat(w) + '  -------\n');
for (const r of rows) {
    process.stderr.write(r.label.padEnd(w) + '  ' + r.verdict
        + (r.verdict === 'PASS' ? `  (${r.ms} ms)` : '  ' + r.detail) + '\n');
}

// Reference vs test time, which is the user-visible half of the same claim: the
// reference is what a page USED to do for every segment.
const refTotal = Object.values(report.referenceMs || {}).reduce((a, b) => a + b, 0);
const testTotal = Object.values(report.testMs || {}).reduce((a, b) => a + b, 0);
process.stderr.write(`\nreference: ${Object.keys(report.referenceMs || {}).length} session(s) in `
    + `${Math.round(refTotal)} ms across ${report.workers.reference} fresh Worker realms\n`);
process.stderr.write(`test:      ${rows.length} pair(s) in ${Math.round(testTotal)} ms in ONE page realm, `
    + `${report.workers.test} Worker(s)\n`);

const problems = [];
if (report.error) problems.push('page threw: ' + report.error.split('\n')[0]);
if (blocked.length) problems.push(`${blocked.length} out-of-scope request(s): ${blocked.map((r) => r.path).join(', ')}`);
// The credential. A test side that spawned Workers ran the reference twice.
if (report.workers.test !== 0) {
    problems.push(`the test side built ${report.workers.test} Worker realm(s) — runSegment fell back off the `
        + 'reset, so this run compared the reference against itself and proves nothing');
}
if (!rows.length) problems.push('no pairs ran');
for (const p of problems) process.stderr.write(`\nFAIL: ${p}\n`);

let ok;
if (noop) {
    // Inverted expectation: the no-op run is evidence only if it fails.
    ok = problems.length === 0 && failures === rows.length;
    process.stderr.write(ok
        ? `\n--noop: ${failures}/${rows.length} pairs failed, as they must. The harness can see a broken reset.\n`
        : `\n--noop: ${rows.length - failures} pair(s) PASSED with a no-op reset. `
          + 'The observable is too weak to be evidence.\n');
} else {
    ok = problems.length === 0 && failures === 0;
    process.stderr.write(`\n${ok ? 'PASS' : 'FAIL'}: ${rows.length - failures}/${rows.length} pairs `
        + 'byte-identical to a fresh Worker realm\n');
}

if (jsonOut) fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify({ ...report, blocked: blocked.map((r) => r.path) }, null, 2));
if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
else process.stderr.write(`(artifacts kept in ${work})\n`);
process.exit(ok ? 0 : 1);
