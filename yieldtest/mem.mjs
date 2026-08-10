#!/usr/bin/env node
// mem.mjs — peak memory of one session, sync engine vs yieldable engine.
//
// Generators are heap objects: every coloured call allocates one and keeps it
// alive for the duration of the call, so at any instant the engine holds a
// generator object per frame of the coloured part of its C stack. This
// measures whether that is a rounding error or a real cost.
//
//   node --expose-gc yieldtest/mem.mjs <session.json> --engine=sync|yield
//
// Reports RSS and heapUsed after module instantiation (the graph cost) and at
// the end of the run, plus the peak sampled every 20 ms.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSession } from '../frozen/session_loader.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const engine = (args.find((a) => a.startsWith('--engine=')) || '--engine=sync').split('=')[1];
const file = args.find((a) => !a.startsWith('--')) || 'sessions/seed4500-knight-coverage.session.json';

const gc = globalThis.gc || (() => {});
const mb = (n) => (n / 1048576).toFixed(1);
const snap = () => { gc(); const m = process.memoryUsage(); return { rss: m.rss, heap: m.heapUsed, ext: m.external }; };

const base = snap();

const entry = engine === 'sync' ? 'js/jsmain.js' : 'js/jsmain-yield.mjs';
const { runSegment } = await import(path.join(repoRoot, entry));

const session = normalizeSession(JSON.parse(readFileSync(path.resolve(repoRoot, file), 'utf8')));
const map = new Map();
const storage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => { map.set(k, String(v)); },
  removeItem: (k) => { map.delete(k); },
  get length() { return map.size; },
  key: (i) => [...map.keys()][i] ?? null,
};

let peakRss = 0, peakHeap = 0;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > peakRss) peakRss = m.rss;
  if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
}, 20);
sampler.unref?.();

let moves = 0;
const t0 = performance.now();
let afterGraph = null;
for (const seg of session.segments) {
  await runSegment({ seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc || '', moves: seg.moves, storage });
  moves += (seg.moves || '').length;
  if (!afterGraph) afterGraph = snap();
}
const wall = performance.now() - t0;
clearInterval(sampler);
const end = snap();

console.log(JSON.stringify({
  engine,
  session: path.basename(file),
  moves,
  wall_ms: Math.round(wall),
  rss_mb: { baseline: +mb(base.rss), afterFirstSegment: +mb(afterGraph.rss), end: +mb(end.rss), peak: +mb(peakRss) },
  heap_mb: { baseline: +mb(base.heap), afterFirstSegment: +mb(afterGraph.heap), end: +mb(end.heap), peak: +mb(peakHeap) },
}, null, 1));
