/**
 * Differential test of the libc the game actually runs: g.* installed by
 * js/boot/harness.mjs, and cptr.*. Boots the port once so the harness's own
 * functions are in place, then replays the C oracle's cases through them.
 * The oracle is tools/c2js/fixtures/libc_real_ref.c, built with clang here.
 *
 * Run from repo root: node test/libc-real.test.mjs [--all]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cptr from '../js/cptr.js';
import { runBootGame } from '../js/boot/harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(repoRoot, '.cache/c2js/build/libc_real_ref');
const SRC = path.join(repoRoot, 'tools/c2js/fixtures/libc_real_ref.c');
fs.mkdirSync(path.dirname(BIN), { recursive: true });
if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(SRC).mtimeMs) {
  execFileSync('clang', ['-w', SRC, '-o', BIN]);
}
const cases = execFileSync(BIN, [], { encoding: 'latin1', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
await runBootGame({ seed: 1, datetime: '20260715120000', moves: '',
  nethackrc: 'OPTIONS=name:X,role:Valkyrie,race:human,gender:female,align:lawful\n' });
process.stdout.write = realWrite;

const g = globalThis;
const bytes = (s) => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return { buf: b, off: 0 }; };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sgn = (x) => (x < 0 ? -1 : x > 0 ? 1 : 0);
const num = (x) => Number(x);
/* Where a name exists in both layers, generated code picks one; test whichever exist. */
const impls = (name) => [['cptr', cptr[name]], ['g', g[name]]].filter(([, f]) => typeof f === 'function');
const SZ = { i: 4, u: 4, l: 8, c: 8, s: 300 };

const failures = new Map();
let pass = 0, total = 0;
function check(key, ok, detail) {
  total++;
  if (ok) { pass++; return; }
  if (!failures.has(key)) failures.set(key, { n: 0, first: detail });
  failures.get(key).n++;
}
function run(label, fn) { try { return fn(); } catch (e) { return `THROW ${e.message}`; } }
const ptrIndex = (p, base) => (p ? p.off - base.off : -1);

for (const c of cases) {
  switch (c.t) {
    case 'sscanf': {
      const outs = [...c.sig].map((k) => new Uint8Array(SZ[k]).fill(0xAA));
      const ret = run('sscanf', () => g.sscanf(bytes(c.in), bytes(c.fmt), ...outs.map((buf) => ({ buf, off: 0 }))));
      const got = outs.map(hex);
      check(`sscanf ${JSON.stringify(c.fmt)}`, ret === c.ret && got.every((h, i) => h === c.out[i]),
        { in: c.in, want: c.ret, got: ret, wantOut: c.out.map((h) => h.slice(0, 24)), gotOut: got.map((h) => h.slice(0, 24)) });
      break;
    }
    case 'printf': {
      const args = [...c.tags].map((t, i) => {
        const v = c.args[i];
        return t === 'l' ? BigInt(v) : t === 's' ? bytes(v) : v;
      });
      const got = run('printf', () => cptr.sprintfCore(bytes(c.fmt), args));
      check(`printf ${JSON.stringify(c.fmt)}`, got === c.want, { args: c.args, want: c.want, got });
      break;
    }
    case 'strcmp': case 'strcasecmp':
      for (const [where, f] of impls(c.t)) { const r = run(c.t, () => sgn(num(f(bytes(c.a), bytes(c.b))))); check(`${where}.${c.t}`, r === c.ret, { a: c.a, b: c.b, want: c.ret, got: r }); }
      break;
    case 'strncmp': case 'strncasecmp':
      for (const [where, f] of impls(c.t)) { const r = run(c.t, () => sgn(num(f(bytes(c.a), bytes(c.b), c.n)))); check(`${where}.${c.t}`, r === c.ret, { a: c.a, b: c.b, n: c.n, want: c.ret, got: r }); }
      break;
    case 'strspn': case 'strcspn':
      for (const [where, f] of impls(c.t)) { const r = run(c.t, () => num(f(bytes(c.a), bytes(c.b)))); check(`${where}.${c.t}`, r === c.ret, { a: c.a, b: c.b, want: c.ret, got: r }); }
      break;
    case 'strpbrk': case 'strstr':
      for (const [where, f] of impls(c.t)) { const a = bytes(c.a); const r = run(c.t, () => ptrIndex(f(a, bytes(c.b)), a)); check(`${where}.${c.t}`, r === c.ret, { a: c.a, b: c.b, want: c.ret, got: r }); }
      break;
    case 'strlen':
      for (const [where, f] of impls('strlen')) { const r = run('strlen', () => num(f(bytes(c.a)))); check(`${where}.strlen`, r === c.ret, { a: c.a, want: c.ret, got: r }); }
      break;
    case 'strchr':
      for (const [where, f] of impls('strchr')) { const a = bytes(c.a); const r = run('strchr', () => ptrIndex(f(a, c.c), a)); check(`${where}.strchr`, r === c.ret, { a: c.a, c: c.c, want: c.ret, got: r }); }
      for (const [where, f] of impls('strrchr')) { const a = bytes(c.a); const r = run('strrchr', () => ptrIndex(f(a, c.c), a)); check(`${where}.strrchr`, r === c.ret2, { a: c.a, c: c.c, want: c.ret2, got: r }); }
      break;
    case 'atoi':
      for (const [where, f] of impls('atoi')) { const r = run('atoi', () => num(f(bytes(c.a)))); check(`${where}.atoi`, r === c.ret, { a: c.a, want: c.ret, got: r }); }
      for (const [where, f] of impls('atol')) { const r = run('atol', () => String(f(bytes(c.a)))); check(`${where}.atol`, r === c.retl, { a: c.a, want: c.retl, got: r }); }
      break;
    case 'strtol': case 'strtoul':
      for (const [where, f] of impls(c.t)) {
        const a = bytes(c.a), end = { isBox: true, v: undefined };
        const r = run(c.t, () => String(f(a, end, c.base)));
        const e = end.v ? end.v.off - a.off : null;
        check(`${where}.${c.t}`, r === c.ret && e === c.end, { a: c.a, base: c.base, want: [c.ret, c.end], got: [r, e] });
      }
      break;
    case 'ctype': {
      const names = ['isalnum', 'isalpha', 'iscntrl', 'isdigit', 'islower', 'isprint', 'ispunct', 'isspace', 'isupper'];
      names.forEach((nm, i) => {
        for (const [where, f] of impls(nm)) { const r = run(nm, () => (f(c.c) ? 1 : 0)); check(`${where}.${nm}`, r === c.r[i], { c: c.c, want: c.r[i], got: r }); }
      });
      const tu = Math.trunc(c.r[9] / 1000), tl = c.r[9] % 1000;
      for (const [where, f] of impls('toupper')) { const r = run('toupper', () => f(c.c)); check(`${where}.toupper`, r === tu, { c: c.c, want: tu, got: r }); }
      for (const [where, f] of impls('tolower')) { const r = run('tolower', () => f(c.c)); check(`${where}.tolower`, r === tl, { c: c.c, want: tl, got: r }); }
      break;
    }
    default: throw new Error(`unknown case ${c.t}`);
  }
}

console.log(`libc-real: ${pass}/${total} matched C`);
for (const [key, f] of [...failures].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(f.n).padStart(5)}  ${key}\n         first: ${JSON.stringify(f.first).slice(0, 320)}`);
}
process.exit(failures.size ? 1 : 0);
