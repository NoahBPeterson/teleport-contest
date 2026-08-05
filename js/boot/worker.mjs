// worker.mjs — one segment per child process (module-state isolation).
// Usage: node js/boot/worker.mjs <job.json> <result.json>
// job:     { seed, datetime, nethackrc, moves, storage: {k: v} | null }
// result:  { screens, cursors, animFramesByStep, rngLog, storage, error, exitCode }

import fs from 'node:fs';
import { runBootGame } from './harness.mjs';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const store = new Map(Object.entries(job.storage || {}));
const storageHandle = job.storage ? {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
} : null;

try {
  const r = await runBootGame({ ...job, storage: storageHandle });
  fs.writeFileSync(process.argv[3], JSON.stringify({
    screens: r.screens,
    cursors: r.cursors,
    animFramesByStep: r.animFramesByStep,
    rngLog: r.rngLog,
    storage: Object.fromEntries(store),
    error: r.error ? String(r.error.stack || r.error) : null,
    exitCode: r.exitCode,
  }));
} catch (e) {
  fs.writeFileSync(process.argv[3], JSON.stringify({
    screens: [], cursors: [], animFramesByStep: [], rngLog: [],
    storage: Object.fromEntries(store),
    error: String(e && (e.stack || e)),
    exitCode: null,
  }));
}
