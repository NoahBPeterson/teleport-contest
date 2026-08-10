#!/usr/bin/env node
// resident.mjs — the resident engine, timed. Sync engine vs yieldable engine,
// measured in exactly the same shape so the numbers are comparable.
//
// This is the thing the whole leg is about. The yieldable engine boots once,
// parks at its first getchar with the entire C stack suspended in generator
// objects, and every subsequent keystroke costs one resume — no re-run of the
// key prefix, no worker, no SharedArrayBuffer, no service worker, and above
// all no blocking, so the same code is legal on a browser main thread.
//
// Three configurations:
//
//   --engine=sync  --drive=sync      the control. js/boot/harness.mjs with a
//                                    waitForKey that returns the next key
//                                    immediately. This is what the engine
//                                    worker does today, minus the thread hop.
//   --engine=yield --drive=sync      the same, through the yieldable build.
//                                    The difference is the mechanism's cost:
//                                    generator allocation and delegation on
//                                    every coloured call.
//   --engine=yield --drive=promise   the browser-realistic loop: the park
//                                    returns to the event loop and a promise
//                                    resolution delivers the key. Adds the
//                                    microtask turn a real page would pay.
//
// The sync engine has no --drive=promise: that configuration is precisely
// what it cannot do, and the reason the fallback re-runs the key prefix.
//
//   node yieldtest/resident.mjs --engine=yield --drive=sync --moves=400

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSession } from '../frozen/session_loader.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const val = (f, d) => { const a = args.find((x) => x.startsWith(f + '=')); return a ? a.split('=').slice(1).join('=') : d; };

const engine = val('--engine', 'yield');
const drive = val('--drive', engine === 'sync' ? 'sync' : 'promise');
const sessionFile = val('--session', 'sessions/seed4500-knight-coverage.session.json');
const maxMoves = Number(val('--moves', '400'));
const warmup = Number(val('--warmup', '20'));
if (engine === 'sync' && drive !== 'sync') {
  console.error('the synchronous engine cannot be driven from the event loop — that is the whole problem');
  process.exit(2);
}

const session = normalizeSession(JSON.parse(readFileSync(path.resolve(repoRoot, sessionFile), 'utf8')));
const seg = session.segments[0];
const keys = [...(seg.moves || '')].map((c) => (c === '\r' ? 10 : c.charCodeAt(0))).slice(0, maxMoves);

const { installBrowserGlobals } = await import(path.join(repoRoot, 'js/boot/browser-env.mjs'));
installBrowserGlobals();

const harness = engine === 'sync' ? 'js/boot/harness.mjs' : 'js/boot/harness-y.mjs';
const t0 = performance.now();
const { runBootGame } = await import(path.join(repoRoot, harness));
const tImport = performance.now();

let stdoutBytes = 0;
const sink = (s) => { stdoutBytes += s.length; };
const job = {
  seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc || '',
  moves: '',                        // nothing queued: park at the very first getchar
  storage: null, stdoutSink: sink,
};

let tFirstFrame = 0;
const times = [];
let delivered = 0;

if (drive === 'sync') {
  // The engine calls back for a key; timestamps taken inside the callback
  // measure engine time only, with no scheduler in the loop. Identical code
  // path for both engines.
  let tLast = 0;
  const nextKey = () => {
    const now = performance.now();
    if (!tFirstFrame) tFirstFrame = now; else times.push(now - tLast);
    if (delivered >= keys.length) return -1;      // EOF: ends the run
    tLast = performance.now();
    return keys[delivered++];
  };
  const opts = engine === 'sync' ? { ...job, waitForKey: nextKey } : { ...job, residentKey: nextKey };
  await runBootGame(opts);
} else {
  // Browser-realistic: the park returns a promise and control leaves for the
  // event loop between every keystroke.
  let deliver = null, onPark = null;
  const residentKey = () => new Promise((res) => { deliver = res; if (onPark) onPark(); });
  const parked = () => new Promise((res) => { onPark = () => { onPark = null; res(); }; });
  let ended = false;
  const boot = runBootGame({ ...job, residentKey });
  boot.then(() => { ended = true; }, () => { ended = true; });
  await parked();
  tFirstFrame = performance.now();
  for (let i = 0; i < keys.length && !ended; i++) {
    const waitNext = parked();
    const t = performance.now();
    const send = deliver; deliver = null;
    send(keys[i]);
    await waitNext;
    times.push(performance.now() - t);
    delivered++;
  }
}

const measured = times.slice(warmup);
const sorted = [...measured].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const sum = measured.reduce((a, b) => a + b, 0);

console.log(JSON.stringify({
  engine, drive,
  session: path.basename(sessionFile),
  keys_delivered: delivered,
  measured_after_warmup: measured.length,
  harness_import_ms: +(tImport - t0).toFixed(1),
  first_frame_ms: +(tFirstFrame - t0).toFixed(1),
  ms_per_move: {
    mean: +(sum / measured.length).toFixed(3),
    median: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    p99: +q(0.99).toFixed(3),
    max: +Math.max(...measured).toFixed(3),
  },
  stdout_bytes: stdoutBytes,
}));

process.exit(0);
