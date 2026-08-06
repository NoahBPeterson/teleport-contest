// playability.mjs — is the play page actually playable, in a real browser?
//
// ps_test_runner measures the *scoring* path. This measures the path a human
// takes: mirror-shaped server, real headless Chrome, real index.html, real
// keydown events, one at a time, timed from dispatch to painted frame.
//
//   node tools/judge-sim/playability.mjs [--coi] [--no-sw] [--keys=hjkl...]
//                                        [--seed=N] [--timeout=ms] [--keep]
//
// --no-sw additionally 404s js/sw.js, which leaves the page with no blocking
// transport at all and forces the ReplayEngine fallback. That is the path the
// judge's browser took, and the only way to measure it here.
//
// --coi serves COOP/COEP so the page is crossOriginIsolated and the engine
// blocks on Atomics.wait over a SharedArrayBuffer. Without it the server
// behaves like GitHub Pages (no COOP/COEP, no SharedArrayBuffer) and the
// engine has to get its keys through the service worker in js/sw.js — that is
// the configuration mazesofmenace.ai actually serves, so it is the default.
//
// Chrome is located at the macOS default; override with CHROME=/path/to/chrome.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const a = args.find(x => x.startsWith('--' + name + '='));
    return a ? a.slice(name.length + 3) : dflt;
};
const coi = args.includes('--coi');
// --no-sw forces the page onto js/boot/interactive.mjs's ReplayEngine fallback
// (no SAB without --coi, and no service worker if its script 404s). Test-only:
// it measures the degraded path, which is the one the judge's browser hit.
const noSw = args.includes('--no-sw');
const timeoutMs = Number(opt('timeout', '180000'));
const PORT = Number(opt('port', String(9500 + (process.pid % 400))));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'playability-'));
const logFile = path.join(work, 'requests.jsonl');
const resultFile = path.join(work, 'bench.json');
const chromeProfile = path.join(work, 'chrome-profile');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'),
    '--port', String(PORT), '--log', logFile, '--result', resultFile,
    ...(coi ? ['--coi'] : []), ...(noSw ? ['--no-sw'] : [])],
    { stdio: ['ignore', 'inherit', 'inherit'] });

let up = false;
for (let i = 0; i < 100 && !up; i++) {
    await sleep(50);
    try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; } catch { /* not yet */ }
}
if (!up) { server.kill(); throw new Error('server never came up'); }

// Pin the character so the measurement happens in the dungeon, walking
// around, rather than in the chargen prompts (which are far cheaper per key
// and would flatter the number).
const DEFAULT_RC = [
    'OPTIONS=name:Bench', 'OPTIONS=role:Valkyrie', 'OPTIONS=race:human',
    'OPTIONS=gender:female', 'OPTIONS=align:neutral', 'OPTIONS=!tutorial',
    'OPTIONS=color,showexp,showscore,time', 'OPTIONS=runmode:walk',
].join('\n') + '\n';

const q = new URLSearchParams({ bench: '/__sim/result', seed: opt('seed', '8000'), rc: opt('rc', DEFAULT_RC) });
const keys = opt('keys', '');
if (keys) q.set('keys', keys);
q.set('bmoves', opt('moves', '240'));
const url = `http://127.0.0.1:${PORT}/?${q}`;

process.stderr.write(`\n=== Headless Chrome: ${url} (COI ${coi ? 'on' : 'off'}) ===\n`);
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
server.kill('SIGINT');
await sleep(200);

const reqs = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
const blocked = reqs.filter(r => r.kind === 'BLOCKED');
const notFound = reqs.filter(r => r.status === 404 && r.kind !== 'BROWSER-UA');
process.stderr.write(`\n=== Request log ===\n  ${reqs.length} requests, ${blocked.length} out-of-scope, ${notFound.length} 404s\n`);
for (const r of [...blocked, ...notFound]) process.stderr.write(`    ${r.kind} ${r.status} ${r.path}\n`);

if (timedOut) {
    process.stderr.write('\nFAIL: the page never reported. Chrome stderr tail:\n' + chromeErr.slice(-4000) + '\n');
    process.exit(1);
}

const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
process.stderr.write('\n=== Interactive play ===\n');
process.stderr.write(`  engine transport : ${report.engine_mode}  (crossOriginIsolated=${report.crossOriginIsolated})\n`);
process.stderr.write(`  moves            : ${report.moves}\n`);
process.stderr.write(`  ms/move          : ${report.ms_per_move}  (median ${report.median_ms}, p95 ${report.p95_ms}, max ${report.max_ms})\n`);
process.stderr.write(`  frames painted   : ${report.frames}\n`);
process.stderr.write(`  top line         : ${JSON.stringify(report.top_line)}\n`);
process.stderr.write(`  status line      : ${JSON.stringify(report.status_line)}\n`);

process.stdout.write('__PLAYABILITY_BROWSER_JSON__\n');
process.stdout.write(JSON.stringify({ ...report, coi, out_of_scope: blocked.map(r => r.path) }, null, 2) + '\n');
if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
else process.stderr.write(`(artifacts kept in ${work})\n`);
process.exit(report.moves > 0 && !blocked.length ? 0 : 1);
