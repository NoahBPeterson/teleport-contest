// runsess.mjs — boot a session's segment 0 and dump stderr (for temporary instrumentation).
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sessFile = process.argv[2];
const segIdx = Number(process.argv[3] || 0);
const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
const seg = sess.segments[segIdx];
try {
  execFileSync('node', [path.join(repoRoot, 'js/boot/boot.mjs'), String(seg.seed), seg.datetime, seg.moves, sessFile],
    { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024, timeout: 240000, stdio: ['ignore', 'ignore', 'inherit'] });
} catch (e) { /* boot may exit non-zero */ }
