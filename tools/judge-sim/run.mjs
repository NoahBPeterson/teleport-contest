// run.mjs — end-to-end judge simulation: mirror-shaped server + real headless
// Chrome + Node reference, then diff.
//
//   node tools/judge-sim/run.mjs <session.json> [--keep] [--timeout ms]
//
// Prints:
//   1. the browser's request log, split IN-SCOPE (/js, /frozen) vs BLOCKED
//   2. per-segment browser vs Node digests
//   3. PASS/FAIL on byte-exact equality
//
// Chrome is located at the macOS default; override with CHROME=/path/to/chrome.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const session = args.find(a => !a.startsWith('--')) || 'seed8000-tourist-starter.session.json';
const timeoutMs = Number((args.find(a => a.startsWith('--timeout=')) || '').split('=')[1] || 300000);
const PORT = Number((args.find(a => a.startsWith('--port=')) || '').split('=')[1] || (9000 + (process.pid % 500)));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-sim-'));
const logFile = path.join(work, 'requests.jsonl');
const resultFile = path.join(work, 'browser.json');
const chromeProfile = path.join(work, 'chrome-profile');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 1. server -----------------------------------------------------------
const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'),
    '--port', String(PORT), '--log', logFile, '--result', resultFile],
    { stdio: ['ignore', 'inherit', 'inherit'] });

let up = false;
for (let i = 0; i < 100 && !up; i++) {
    await sleep(50);
    try { await fetch(`http://127.0.0.1:${PORT}/js/jsmain.js`); up = true; } catch {}
}
if (!up) { server.kill(); throw new Error('server never came up'); }

// ---- 2. Node reference (run first; it is the thing we compare against) ----
process.stderr.write(`\n=== Node reference: ${session} ===\n`);
const nodeRun = spawnSync(process.execPath, [path.join(HERE, 'node-ref.mjs'), session], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs,
});
process.stderr.write(nodeRun.stderr || '');
let nodeReport;
try { nodeReport = JSON.parse(nodeRun.stdout); }
catch { server.kill(); throw new Error('node-ref produced no JSON: ' + (nodeRun.stderr || '').slice(-2000)); }

// ---- 3. real headless Chrome --------------------------------------------
process.stderr.write(`\n=== Headless Chrome: ${session} ===\n`);
const url = `http://127.0.0.1:${PORT}/__sim/driver.html?session=${encodeURIComponent(session)}`;
const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${chromeProfile}`,
    '--enable-logging=stderr',
    '--v=0',
    url,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d; });
chrome.stdout.on('data', d => { chromeErr += d; });

const deadline = Date.now() + timeoutMs;
while (!fs.existsSync(resultFile) && Date.now() < deadline) await sleep(200);
const timedOut = !fs.existsSync(resultFile);
chrome.kill();
await sleep(200);

// ---- 4. request log ------------------------------------------------------
server.kill('SIGINT');
await sleep(300);
const reqs = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
const byKind = {};
for (const r of reqs) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
const blocked = reqs.filter(r => r.kind === 'BLOCKED');
const notFound = reqs.filter(r => r.status === 404);

process.stderr.write('\n=== Request log ===\n');
process.stderr.write(`  total ${reqs.length}  ${JSON.stringify(byKind)}\n`);
process.stderr.write(`  404s: ${notFound.length}${notFound.length ? ' -> ' + notFound.map(r => r.path).join(', ') : ''}\n`);
process.stderr.write(`  out-of-scope (would 404 on the mirror): ${blocked.length}\n`);
for (const r of blocked) process.stderr.write(`    ${r.path}\n`);
const dirs = {};
for (const r of reqs) {
    const d = r.path.split('/').slice(0, 3).join('/');
    dirs[d] = (dirs[d] || 0) + 1;
}
process.stderr.write('  by prefix: ' + JSON.stringify(dirs) + '\n');

// ---- 5. compare ----------------------------------------------------------
if (timedOut) {
    process.stderr.write('\nFAIL: browser never posted a result. Chrome stderr tail:\n');
    process.stderr.write(chromeErr.slice(-4000) + '\n');
    process.exit(1);
}
const browserReport = JSON.parse(fs.readFileSync(resultFile, 'utf8'));

process.stderr.write('\n=== Browser vs Node ===\n');
if (!browserReport.ok) {
    process.stderr.write('  browser error: ' + browserReport.error + '\n');
}
const FIELDS = ['screens', 'cursors', 'rng', 'screensSha', 'cursorsSha', 'rngSha'];
let mismatches = 0;
const n = Math.max(browserReport.segments.length, nodeReport.segments.length);
for (let i = 0; i < n; i++) {
    const b = browserReport.segments[i], d = nodeReport.segments[i];
    if (!b || !d) { mismatches++; process.stderr.write(`  seg ${i + 1}: MISSING on ${b ? 'node' : 'browser'} side\n`); continue; }
    const bad = FIELDS.filter(f => JSON.stringify(b[f]) !== JSON.stringify(d[f]));
    if (bad.length) {
        mismatches++;
        process.stderr.write(`  seg ${i + 1}: MISMATCH [${bad.join(', ')}]\n`);
        for (const f of bad) process.stderr.write(`      ${f}: browser=${JSON.stringify(b[f])} node=${JSON.stringify(d[f])}\n`);
    } else {
        process.stderr.write(`  seg ${i + 1}: match  screens=${b.screens} rng=${b.rng}  rngSha=${b.rngSha.slice(0, 16)}…  (browser ${b.ms}ms / node ${d.ms}ms)\n`);
    }
}

const ok = browserReport.ok && nodeReport.ok && mismatches === 0 && blocked.length === 0;
process.stderr.write(`\n${ok ? 'PASS' : 'FAIL'}: ${session} — ${mismatches} segment mismatch(es), ${blocked.length} out-of-scope request(s)\n`);

const summary = { session, ok, mismatches, requests: byKind, blocked: blocked.map(r => r.path), browser: browserReport, node: nodeReport };
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
else process.stderr.write(`(artifacts kept in ${work})\n`);
process.exit(ok ? 0 : 1);
