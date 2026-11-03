#!/usr/bin/env node
// Check js/cptr.js darwinQsort() against the host libc qsort, comparison for
// comparison.  macOS only (the recordings' libc).  Usage: node run.mjs
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process'; import { fileURLToPath } from 'url';
import { darwinQsort } from '../../js/cptr.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qsortchk-'));
const bin = path.join(tmp, 'ref');
execFileSync('cc', ['-O1', '-o', bin, path.join(here, 'ref.c')]);
let seed = 7; const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const cases = [];
const sizes = [...Array(13).keys(), 20, 33, 40, 41, 47, 63, 64];
for (let i = 0; i < 300; i++) sizes.push(2 + rnd(63));
for (let i = 0; i < 300; i++) sizes.push(41 + rnd(360));
for (const n of sizes) {
  const span = [1, 2, 10, n][rnd(4)] || 1;
  const keys = Array.from({ length: n }, () => rnd(span + 1));
  for (const mode of [0, 1]) cases.push({ n, keys, mode });
}
const input = `${cases.length}\n` + cases.map(c => `${c.n} ${c.keys.join(' ')} ${c.mode}`).join('\n') + '\n';
const ref = execFileSync(bin, { input, maxBuffer: 1 << 28 }).toString().trim().split('\n');
let s = 12345 >>> 0; const tbl = [];
for (let i = 0; i < 64; i++) { tbl.push([]); for (let j = 0; j < 64; j++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; tbl[i].push(((s >>> 16) % 3) - 1); } }
const out = [];
for (const { n, keys, mode } of cases) {
  out.push(`case ${n}`);
  const v = [...Array(n).keys()];
  darwinQsort(v, (a, b) => { out.push(`c ${a} ${b}`); return mode === 0 ? (keys[a] > keys[b]) - (keys[a] < keys[b]) : tbl[a & 63][(b * 7 + a) & 63]; });
  out.push('o' + v.map(x => ' ' + x).join(''));
}
fs.rmSync(tmp, { recursive: true, force: true });
for (let i = 0; i < Math.max(ref.length, out.length); i++)
  if (ref[i] !== out[i]) { console.error(`MISMATCH at trace line ${i}: libc ${JSON.stringify(ref[i])} js ${JSON.stringify(out[i])}`); process.exit(1); }
console.log(`ok: ${cases.length} arrays, ${ref.length} trace lines identical`);
