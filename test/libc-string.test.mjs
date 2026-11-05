/**
 * Differential parity harness for the string functions the game runs: cptr.*
 * and the g.* installed by js/boot/harness.mjs. Boots the port once to get g.*.
 *
 * 1. Compiles tools/c2js/fixtures/string_battery.c with clang and runs it:
 *    the C driver prints one block per case —
 *      # <fn> <idx>
 *      IN <tok> ...   tok = s<k>:<hex> (NUL-terminated string at buf k, off 0)
 *                            b<k>:<off>:<hex> (raw bytes at buf k, off)
 *                            i:<v> (int arg)   n:<v> (size_t arg)
 *      RET int:<v> | RET size:<v> | RET ptr:<k>:<off> | RET null
 *      BUF0..2 <hex>   (full 64-byte buffer dumps, always)
 * 2. Replays every IN line through each layer over Uint8Array buffers
 *    and diffs the RET/BUF lines byte-for-byte against the C transcript.
 *
 * Run from repo root: node test/libc-string.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as CP from '../js/cptr.js';
import { runBootGame } from '../js/boot/harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(repoRoot, '.cache/c2js/build');
const BIN = path.join(BUILD_DIR, 'string_battery');
const FIXTURE = path.join(repoRoot, 'tools/c2js/fixtures/string_battery.c');

// ---- build + run the C side ----
fs.mkdirSync(BUILD_DIR, { recursive: true });
const stale = !fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(FIXTURE).mtimeMs;
if (stale) {
  execFileSync('clang', [FIXTURE, '-o', BIN], { stdio: 'inherit' });
}
const transcript = execFileSync(BIN, [], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---- buffer model (mirrors the C driver) ----
const NBUF = 3, BSZ = 64;
const bufs = Array.from({ length: NBUF }, () => new Uint8Array(BSZ));
const resetBufs = () => bufs.forEach((b) => b.fill(0));
const hexBytes = (u8, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += u8[off + i].toString(16).padStart(2, '0');
  return s;
};

// ---- IN decoding ----
function decodeIn(tokens) {
  const dec = { ptrs: {}, args: [] };
  for (const tok of tokens) {
    if (tok.startsWith('i:') || tok.startsWith('n:')) {
      dec.args.push(Number(tok.slice(2)));
      continue;
    }
    const m = tok.match(/^([sb])(\d+)(?::(\d+))?:(.*)$/);
    if (!m) throw new Error(`bad token: ${tok}`);
    const kind = m[1];
    const k = Number(m[2]);
    const off = kind === 'b' ? Number(m[3]) : 0;
    const hex = m[4];
    const nbytes = hex.length / 2;
    for (let i = 0; i < nbytes; i++) bufs[k][off + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (kind === 's') bufs[k][off + nbytes] = 0; // NUL-terminate
    dec.ptrs[k] = { buf: bufs[k], off };
  }
  return dec;
}

// ---- output rendering ----
const bufLines = () => bufs.map((b, k) => `BUF${k} ${hexBytes(b, 0, BSZ)}`);
const retInt = (v) => `RET int:${Number(v)}`;
const retSize = (v) => `RET size:${Number(v)}`;
const retPtr = (r) => {
  if (r === null || r === undefined) return 'RET null';
  for (let k = 0; k < NBUF; k++) if (r.buf === bufs[k]) return `RET ptr:${k}:${r.off}`;
  return 'RET other';
};

const DISPATCH = {
  strlen: ({ ptrs }, M) => [retSize(M.strlen(ptrs[0])), ...bufLines()],
  strcpy: ({ ptrs }, M) => [retPtr(M.strcpy(ptrs[1], ptrs[0])), ...bufLines()],
  strncpy: ({ ptrs, args }, M) => [retPtr(M.strncpy(ptrs[1], ptrs[0], args[0])), ...bufLines()],
  strcat: ({ ptrs }, M) => [retPtr(M.strcat(ptrs[0], ptrs[1])), ...bufLines()],
  strncat: ({ ptrs, args }, M) => [retPtr(M.strncat(ptrs[0], ptrs[1], args[0])), ...bufLines()],
  strcmp: ({ ptrs }, M) => [retInt(M.strcmp(ptrs[0], ptrs[1])), ...bufLines()],
  strncmp: ({ ptrs, args }, M) => [retInt(M.strncmp(ptrs[0], ptrs[1], args[0])), ...bufLines()],
  strcasecmp: ({ ptrs }, M) => [retInt(M.strcasecmp(ptrs[0], ptrs[1])), ...bufLines()],
  strncasecmp: ({ ptrs, args }, M) => [retInt(M.strncasecmp(ptrs[0], ptrs[1], args[0])), ...bufLines()],
  strchr: ({ ptrs, args }, M) => [retPtr(M.strchr(ptrs[0], args[0])), ...bufLines()],
  strrchr: ({ ptrs, args }, M) => [retPtr(M.strrchr(ptrs[0], args[0])), ...bufLines()],
  strstr: ({ ptrs }, M) => [retPtr(M.strstr(ptrs[0], ptrs[1])), ...bufLines()],
  strspn: ({ ptrs }, M) => [retSize(M.strspn(ptrs[0], ptrs[1])), ...bufLines()],
  strcspn: ({ ptrs }, M) => [retSize(M.strcspn(ptrs[0], ptrs[1])), ...bufLines()],
  strpbrk: ({ ptrs }, M) => [retPtr(M.strpbrk(ptrs[0], ptrs[1])), ...bufLines()],
  memcpy: ({ ptrs, args }, M) => [retPtr(M.memcpy(ptrs[2], ptrs[0], args[0])), ...bufLines()],
  memmove: ({ ptrs, args }, M) => {
    const [d, s, n] = args;
    return [retPtr(M.memmove({ buf: bufs[0], off: d }, { buf: bufs[0], off: s }, n)), ...bufLines()];
  },
  memset: ({ ptrs, args }, M) => [retPtr(M.memset(ptrs[0], args[0], args[1])), ...bufLines()],
  memcmp: ({ ptrs, args }, M) => [retInt(M.memcmp(ptrs[0], ptrs[1], args[0])), ...bufLines()],
  memchr: ({ ptrs, args }, M) => [retPtr(M.memchr(ptrs[0], args[0], args[1])), ...bufLines()],
  isalpha: ({ args }, M) => [retInt(M.isalpha(args[0])), ...bufLines()],
  isdigit: ({ args }, M) => [retInt(M.isdigit(args[0])), ...bufLines()],
  isalnum: ({ args }, M) => [retInt(M.isalnum(args[0])), ...bufLines()],
  isspace: ({ args }, M) => [retInt(M.isspace(args[0])), ...bufLines()],
  isupper: ({ args }, M) => [retInt(M.isupper(args[0])), ...bufLines()],
  islower: ({ args }, M) => [retInt(M.islower(args[0])), ...bufLines()],
  isxdigit: ({ args }, M) => [retInt(M.isxdigit(args[0])), ...bufLines()],
  toupper: ({ args }, M) => [retInt(M.toupper(args[0])), ...bufLines()],
  tolower: ({ args }, M) => [retInt(M.tolower(args[0])), ...bufLines()],
};

// ---- parse transcript, replay, diff ----
const lines = transcript.split('\n');
let total = 0, pass = 0;
const failures = [];

const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
await runBootGame({ seed: 1, datetime: '20260715120000', moves: '',
  nethackrc: 'OPTIONS=name:X,role:Valkyrie,race:human,gender:female,align:lawful\n' });
process.stdout.write = realWrite;

for (let li = 0; li < lines.length; li++) {
  const m = lines[li].match(/^# (\S+) (\d+)$/);
  if (!m) continue;
  const fn = m[1], idx = m[2];
  li++;
  let tokens = [];
  if (lines[li]?.startsWith('IN ')) {
    tokens = lines[li].slice(3).trim().split(/\s+/).filter(Boolean);
    li++;
  }
  const expected = [];
  while (li < lines.length && /^(RET|BUF)/.test(lines[li])) {
    expected.push(lines[li]);
    li++;
  }
  li--;
  // generated code resolves a name in cptr first, then in g; test both when both exist
  for (const [layer, M] of [['cptr', CP], ['g', globalThis]]) {
    if (typeof M[fn] !== 'function') continue;
    total++;
    resetBufs();
    let got;
    try {
      got = DISPATCH[fn](decodeIn(tokens), M);
    } catch (err) {
      failures.push({ fn: `${layer}.${fn}`, idx, err: String(err.stack || err) });
      continue;
    }
    if (got.join('\n') === expected.join('\n')) pass++;
    else failures.push({ fn: `${layer}.${fn}`, idx, expected, got });
  }
}

console.log(`string battery: ${pass}/${total} cases passed`);
if (failures.length > 0) {
  console.error('Failures:');
  for (const f of failures.slice(0, 40)) {
    console.error(`--- ${f.fn} #${f.idx}`);
    if (f.err) console.error(`    error: ${f.err.split('\n')[0]}`);
    else {
      console.error(`    C : ${f.expected.join(' | ')}`);
      console.error(`    JS: ${f.got.join(' | ')}`);
    }
  }
  process.exit(1);
} else {
  console.log('All string tests passed.');
}
