// boot.mjs — CLI boot harness for the transpiled NetHack (js/generated/*).
// Thin wrapper over js/boot/harness.mjs (runBootGame); see docs/INTEGRATION-NOTES.md.
//
// Usage: node js/boot/boot.mjs [seed] [datetime] [moves] [session.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBootGame } from './harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const seed = process.argv[2] || '8000';
const datetime = process.argv[3] || '20260401090000';
const moves = process.argv[4] || '  ';

let nethackrc = '';
try {
  const sess = JSON.parse(fs.readFileSync(process.argv[5] || path.join(repoRoot, 'sessions/seed8000-tourist-starter.session.json'), 'utf8'));
  const seg = (sess.segments || [])[0] || {};
  if (seg.nethackrc) nethackrc = seg.nethackrc;
} catch {}

const r = await runBootGame({
  seed, datetime, moves, nethackrc,
  trace: true,
  stdoutSink: (s) => process.stdout.write(s),
});
fs.writeFileSync('/tmp/c2js-rnglog.txt', r.rngLog.join('\n') + '\n');
if (r.error) {
  console.error('[boot] error:', r.error.stack || r.error);
  process.exitCode = 1;
} else {
  console.error(`[boot] done (exitCode=${r.exitCode}, screens=${r.screens.length}, rng=${r.rngLog.length})`);
}
