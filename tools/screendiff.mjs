// screendiff.mjs — run boot on a session, compare decoded input frames vs recording.
// Usage: node screendiff.mjs <session.json> [stepFilter...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { decodeScreen, diffCell } = await import(path.join(repoRoot, 'frozen/screen-decode.mjs'));

const sessFile = process.argv[2];
const only = process.argv.slice(3).map(Number);
const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
const seg = sess.segments[0];

let out;
try {
  out = execFileSync('node', [path.join(repoRoot, 'js/boot/boot.mjs'), String(seg.seed), seg.datetime, seg.moves, sessFile], {
    cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 240000, stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) { out = e.stdout || Buffer.alloc(0); }

const frames = [];
let i = 0;
while (i < out.length) {
  const m = out.indexOf('\x1b]7777;', i);
  if (m < 0) break;
  const end = out.indexOf('\x07', m);
  const hdr = out.slice(m, end).toString();
  const kv = Object.fromEntries(hdr.slice(7).split(';').map((p) => p.split('=')));
  const len = Number(kv.LEN);
  frames.push({ kind: kv.KIND, seq: Number(kv.SEQ), cx: Number(kv.CX), cy: Number(kv.CY), screen: out.slice(end + 1, end + 1 + len).toString().replace(/ {5,}/g, (m) => `\x1b[${m.length}C`) });
  i = end + 1 + len;
}
const inputFrames = frames.filter((f) => f.kind === 'input');
const steps = seg.steps || [];
console.log(`[diff] inputFrames=${inputFrames.length} steps=${steps.length}`);

const cellStr = (c) => c ? `${JSON.stringify(c.ch)} color=${c.color} attr=${c.attr}${c.decgfx ? ' DEC' : ''}` : 'null';
let pass = 0; const mismatched = [];
for (let s = 0; s < steps.length; s++) {
  const wantRaw = steps[s].screen;
  const f = inputFrames[s];
  if (!f) { console.log(`step ${s}: NO FRAME`); continue; }
  const want = decodeScreen(wantRaw), got = decodeScreen(f.screen);
  let bad = 0;
  const diffs = [];
  for (let r = 0; r < 24; r++) for (let c = 0; c < 80; c++) {
    const a = want[r][c], b = got[r][c];
    if (diffCell(a, b)) { bad++; if (diffs.length < 400) diffs.push([r, c, a, b]); }
  }
  const curOk = steps[s].cursor ? (f.cx === steps[s].cursor[0] && f.cy === steps[s].cursor[1]) : true;
  if (!bad && curOk) { pass++; continue; }
  mismatched.push(s);
  if (only.length && !only.includes(s)) continue;
  console.log(`--- step ${s} key=${JSON.stringify(steps[s].key)} cells=${bad} cursor want=${JSON.stringify(steps[s].cursor)} got=[${f.cx},${f.cy}] ---`);
  // group by row
  const byRow = new Map();
  for (const [r, c, a, b] of diffs) { if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push([c, a, b]); }
  for (const [r, list] of byRow) {
    const wl = want[r].map((c) => c ? c.ch : ' ').join('');
    const gl = got[r].map((c) => c ? c.ch : ' ').join('');
    console.log(` row ${r} (${list.length} cells)`);
    console.log(`   want: ${JSON.stringify(wl)}`);
    console.log(`   got:  ${JSON.stringify(gl)}`);
    if (list.length <= 40) for (const [c, a, b] of list) console.log(`     col ${c}: want ${cellStr(a)} got ${cellStr(b)}`);
  }
}
console.log(`[diff] pass=${pass}/${steps.length} mismatched steps: ${mismatched.join(',')}`);
