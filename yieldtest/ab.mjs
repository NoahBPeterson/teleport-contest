#!/usr/bin/env node
// ab.mjs — interleaved A/B between the synchronous engine and the yieldable one.
//
// Follows the project's standing methodology (docs/NOTES-speed-stage1.md,
// NOTES-speed-stage2.md): alternate runs in the same shell, never batch one
// side then the other; take best-of-N per session and sum; report medians with
// the full range; discard the cold first pair.
//
//   A = frozen/ps_test_runner.mjs      -> js/jsmain.js      -> js/generated/
//   B = yieldtest/ps_test_runner.mjs   -> js/jsmain-yield.mjs -> js/generated-y/
//
// Both runners spawn one child per session and report per-session
// `time.ms` (engine time only) plus an OLS fit of startup_ms + per_move_ms.
// Only B's numbers can move; A is the control for machine state.
//
// Usage:
//   node yieldtest/ab.mjs --pairs=5 sessions/
//   node yieldtest/ab.mjs --pairs=3 sessions/seed4500-knight-coverage.session.json

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pairs = Number((args.find((a) => a.startsWith('--pairs=')) || '--pairs=5').split('=')[1]);
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) targets.push('sessions/');

const SIDES = [
  { name: 'sync ', runner: 'frozen/ps_test_runner.mjs' },
  { name: 'yield', runner: 'yieldtest/ps_test_runner.mjs' },
];

function runOnce(runner) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(repoRoot, runner), ...targets], {
    cwd: repoRoot,
    env: { ...process.env, SESSION_REPLAY_TIMEOUT_MS: process.env.SESSION_REPLAY_TIMEOUT_MS || '300000' },
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  const wall = Date.now() - t0;
  const out = r.stdout || '';
  const i = out.lastIndexOf('__RESULTS_JSON__');
  if (i < 0) return { wall, error: (r.stderr || '').slice(-2000) };
  const bundle = JSON.parse(out.slice(i + '__RESULTS_JSON__'.length));
  const byName = new Map();
  let engineMs = 0, moves = 0, passing = 0;
  for (const s of bundle.results) {
    byName.set(s.session, s.time?.ms ?? 0);
    engineMs += s.time?.ms ?? 0;
    moves += s.time?.moves ?? 0;
    if (s.passed) passing++;
  }
  return { wall, engineMs, moves, passing, total: bundle.results.length, speed: bundle.speed, byName };
}

const runs = { 'sync ': [], yield: [] };
for (let p = 0; p < pairs; p++) {
  for (const side of SIDES) {
    const r = runOnce(side.runner);
    runs[side.name].push(r);
    process.stderr.write(`pair ${p + 1} ${side.name}: `
      + (r.error ? `ERROR ${r.error.split('\n')[0]}`
        : `${r.passing}/${r.total} pass, engine ${r.engineMs.toFixed(0)} ms, wall ${r.wall} ms, `
          + `fit ${r.speed.startup_ms.toFixed(1)}+${r.speed.per_move_ms.toFixed(4)}/turn (R²=${r.speed.r2.toFixed(3)})`)
      + '\n');
  }
}

// ---- report ----
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtRange = (a) => `${median(a).toFixed(1)} (${Math.min(...a).toFixed(1)} – ${Math.max(...a).toFixed(1)})`;

console.log('\n=== interleaved A/B, %d pairs (pair 1 discarded as cold) ===', pairs);
const usable = (side) => runs[side].slice(1).filter((r) => !r.error);

for (const side of ['sync ', 'yield']) {
  const rs = usable(side);
  if (!rs.length) { console.log(`${side}: no usable runs`); continue; }
  console.log(`${side}  engine ms  ${fmtRange(rs.map((r) => r.engineMs))}`);
  console.log(`${side}  wall ms    ${fmtRange(rs.map((r) => r.wall))}`);
  console.log(`${side}  startup_ms ${fmtRange(rs.map((r) => r.speed.startup_ms))}`);
  console.log(`${side}  per_move   ${median(rs.map((r) => r.speed.per_move_ms)).toFixed(4)} ms  (${Math.min(...rs.map((r) => r.speed.per_move_ms)).toFixed(4)} – ${Math.max(...rs.map((r) => r.speed.per_move_ms)).toFixed(4)})`);
  console.log(`${side}  passing    ${rs.map((r) => `${r.passing}/${r.total}`).join(' ')}`);
}

// best-of-N per session, summed — the primary estimator on a contended machine
const bestSum = {};
for (const side of ['sync ', 'yield']) {
  const rs = usable(side);
  if (!rs.length) continue;
  const names = new Set(rs.flatMap((r) => [...r.byName.keys()]));
  let sum = 0;
  for (const n of names) sum += Math.min(...rs.map((r) => r.byName.get(n) ?? Infinity));
  bestSum[side] = sum;
}
if (bestSum['sync '] && bestSum.yield) {
  console.log(`\nbest-of-N per session, summed:`);
  console.log(`  sync   ${bestSum['sync '].toFixed(0)} ms`);
  console.log(`  yield  ${bestSum.yield.toFixed(0)} ms`);
  console.log(`  ratio  ${(bestSum.yield / bestSum['sync ']).toFixed(3)}x  (${((bestSum.yield / bestSum['sync '] - 1) * 100).toFixed(1)}% slower)`);
}

const syncFit = usable('sync ').map((r) => r.speed);
const yFit = usable('yield').map((r) => r.speed);
if (syncFit.length && yFit.length) {
  console.log(`\nOLS fit medians:`);
  console.log(`  startup_ms   sync ${median(syncFit.map((s) => s.startup_ms)).toFixed(1)}  ->  yield ${median(yFit.map((s) => s.startup_ms)).toFixed(1)}`
    + `   (${((median(yFit.map((s) => s.startup_ms)) / median(syncFit.map((s) => s.startup_ms)) - 1) * 100).toFixed(1)}%)`);
  console.log(`  per_move_ms  sync ${median(syncFit.map((s) => s.per_move_ms)).toFixed(4)}  ->  yield ${median(yFit.map((s) => s.per_move_ms)).toFixed(4)}`
    + `   (${((median(yFit.map((s) => s.per_move_ms)) / median(syncFit.map((s) => s.per_move_ms)) - 1) * 100).toFixed(1)}%)`);
}
