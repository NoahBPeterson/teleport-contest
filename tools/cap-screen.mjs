// cap-screen.mjs — run the boot with session moves, split nomux markers,
// diff captured frames against the session's recorded screens.
// Usage: node tools/cap-screen.mjs [session.json] [frameCount]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessFile = process.argv[2] || path.join(repoRoot, 'sessions/seed8000-tourist-starter.session.json');
const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
const seg = sess.segments[0];

let out;
try {
  out = execFileSync('node', [path.join(repoRoot, 'js/boot/boot.mjs'), String(seg.seed), seg.datetime, seg.moves], {
    cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 240000, stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) {
  out = e.stdout || Buffer.alloc(0); // boot exits non-zero at input EOF — frames so far still count
}

// markers: \x1b]7777;KIND=..;SEQ=n;ANIM=a;CX=x;CY=y;LEN=z\x07<LEN bytes of screen>
const frames = [];
let i = 0;
while (i < out.length) {
  const m = out.indexOf('\x1b]7777;', i);
  if (m < 0) break;
  const end = out.indexOf('\x07', m);
  const hdr = out.slice(m, end).toString();
  const kv = Object.fromEntries(hdr.slice(7).split(';').map((p) => p.split('=')));
  const len = Number(kv.LEN);
  const screen = out.slice(end + 1, end + 1 + len).toString();
  frames.push({ kind: kv.KIND, seq: Number(kv.SEQ), anim: Number(kv.ANIM), cx: Number(kv.CX), cy: Number(kv.CY), screen });
  i = end + 1 + len;
}
console.error(`[cap] ${frames.length} frames`);

const steps = seg.steps || [];
let pass = 0, fail = 0;
for (let s = 0; s < steps.length && s < frames.length; s++) {
  const want = steps[s].screen;
  const got = frames[s].screen;
  if (got === want) { pass++; continue; }
  fail++;
  console.log(`--- step ${s} (key ${JSON.stringify(steps[s].key)}) MISMATCH frame SEQ=${frames[s].seq} ---`);
  const wl = want.split('\n'), gl = got.split('\n');
  for (let r = 0; r < 24; r++) {
    if (wl[r] !== gl[r]) {
      console.log(`row ${r} want: ${JSON.stringify(wl[r])}`);
      console.log(`row ${r} got:  ${JSON.stringify(gl[r])}`);
    }
  }
  if (s >= 2) break; // first few mismatches are enough
}
console.log(`[cap] steps compared: ${Math.min(steps.length, frames.length)}, match: ${pass}, mismatch: ${fail}`);
if (frames.length) {
  fs.writeFileSync('/tmp/c2js-frame0.txt', frames[0].screen);
  console.error('[cap] frame0 written to /tmp/c2js-frame0.txt (cx,cy =', frames[0].cx, frames[0].cy, ')');
}
