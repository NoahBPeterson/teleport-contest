// rawdiff.mjs — dump raw serialized screen (want vs got) for one step.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sessFile = process.argv[2]; const step = Number(process.argv[3]);
const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); const seg = sess.segments[0];
let out;
try { out = execFileSync('node', [path.join(repoRoot, 'js/boot/boot.mjs'), String(seg.seed), seg.datetime, seg.moves, sessFile], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 240000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { out = e.stdout || Buffer.alloc(0); }
const frames = []; let i = 0;
while (i < out.length) { const m = out.indexOf('\x1b]7777;', i); if (m < 0) break; const end = out.indexOf('\x07', m); const hdr = out.slice(m, end).toString(); const kv = Object.fromEntries(hdr.slice(7).split(';').map((p) => p.split('='))); const len = Number(kv.LEN); frames.push({ kind: kv.KIND, screen: out.slice(end + 1, end + 1 + len).toString() }); i = end + 1 + len; }
const inp = frames.filter((f) => f.kind === 'input');
const esc = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC');
console.log('WANT:'); console.log(esc(seg.steps[step].screen));
console.log('GOT:'); console.log(esc(inp[step].screen));
