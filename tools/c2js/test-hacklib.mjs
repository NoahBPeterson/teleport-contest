#!/usr/bin/env node
// test-hacklib.mjs — differential parity harness for the transpiled hacklib.c.
//
// 1. Compiles tools/c2js/fixtures/hacklib_battery.c against the recorder's
//    hacklib.o (cached in .cache/c2js/build/) and runs it: the C driver
//    prints one block per case — `# fn idx`, `IN ...` (inputs), then
//    RET/BUF/DATA lines (outputs).
// 2. Replays every IN line through js/generated/hacklib.js, reproducing the
//    same output lines, and diffs them against the C transcript.
// Byte-exact required.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD_DIR = path.join(repoRoot, '.cache/c2js/build');
const BIN = path.join(BUILD_DIR, 'hacklib_battery');
const FIXTURE = path.join(repoRoot, 'tools/c2js/fixtures/hacklib_battery.c');
const HACKLIB_O = path.join(repoRoot, 'nethack-c/recorder/src/hacklib.o');

const cptr = await import(pathToFileURL(path.join(repoRoot, 'js/cptr.js')).href);
const schar = (v) => (v << 24) >> 24;
const uchar = (v) => v & 0xFF;

// ---- build + run the C side ----
fs.mkdirSync(BUILD_DIR, { recursive: true });
const stale = !fs.existsSync(BIN) ||
  fs.statSync(BIN).mtimeMs < fs.statSync(FIXTURE).mtimeMs ||
  fs.statSync(BIN).mtimeMs < fs.statSync(HACKLIB_O).mtimeMs;
if (stale) {
  execFileSync('clang', ['-I', path.join(repoRoot, 'nethack-c/recorder/include'),
    '-DNOTPARMDECL', '-DNO_TIMED_DELAY', FIXTURE, HACKLIB_O, '-o', BIN], { stdio: 'inherit' });
}
const transcript = execFileSync(BIN, [], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const mod = await import(pathToFileURL(path.join(repoRoot, 'js/generated/hacklib.js')).href);

// ---- replay machinery ----
const NBUF = 3, BSZ = 512;
const bufs = Array.from({ length: NBUF }, () => new Uint8Array(BSZ));
const resetBufs = () => bufs.forEach((b) => b.fill(0));
function unhex(h, b) { for (let i = 0; i < h.length; i += 2) b[i / 2] = parseInt(h.slice(i, i + 2), 16); }
function hexCStr(p) { // hex of C string at CPtr
  let s = '';
  for (let i = p.off; i < p.buf.length && p.buf[i] !== 0; i++) s += p.buf[i].toString(16).padStart(2, '0');
  return s;
}
function hexBytes(u8) { return [...u8].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function retPtr(p) {
  if (p === null || p === undefined) return 'RET null';
  for (let i = 0; i < NBUF; i++) {
    if (p.buf === bufs[i]) return `RET ptr:${i}:${p.off}:${hexCStr(p)}`;
  }
  return `RET str:${hexCStr(p)}`;
}
const retInt = (v) => `RET int:${Number(v)}`;
const pbuf = (k) => `BUF${k} ${hexCStr(cptr.decay(bufs[k]))}`;

// nh_deterministic_qsort compar: int32 elements
const intcmp = (a, b) => { const x = cptr.ldI32(a), y = cptr.ldI32(b); return (x > y) - (x < y); };

// per-fn replay: args = IN tokens (strings already split); returns output lines
const DISPATCH = {
  digit: ([c]) => [retInt(mod.digit(schar(Number(c))))],
  letter: ([c]) => [retInt(mod.letter(schar(Number(c))))],
  highc: ([c]) => [retInt(uchar(mod.highc(schar(Number(c)))))],
  lowc: ([c]) => [retInt(uchar(mod.lowc(schar(Number(c)))))],
  visctrl: ([c]) => [retPtr(mod.visctrl(schar(Number(c))))],
  chrcasecpy: ([a, b]) => [retInt(uchar(mod.chrcasecpy(Number(a), Number(b))))],
  eos: () => [retPtr(mod.eos(cptr.decay(bufs[0])))],
  c_eos: () => [retPtr(mod.c_eos(cptr.decay(bufs[0])))],
  onlyspace: () => [retInt(mod.onlyspace(cptr.decay(bufs[0])))],
  str_lines_maxlen: () => [retInt(mod.str_lines_maxlen(cptr.decay(bufs[0])))],
  s_suffix: () => [retPtr(mod.s_suffix(cptr.decay(bufs[0])))],
  ing_suffix: () => [retPtr(mod.ing_suffix(cptr.decay(bufs[0])))],
  xcrypt: () => [retPtr(mod.xcrypt(cptr.decay(bufs[0]), cptr.decay(bufs[1]))), pbuf(1)],
  strkitten: ([, c]) => [retPtr(mod.strkitten(cptr.decay(bufs[0]), schar(Number(c)))), pbuf(0)],
  copynchars: ([, n]) => { mod.copynchars(cptr.decay(bufs[1]), cptr.decay(bufs[0]), Number(n)); return [pbuf(1)]; },
  strcasecpy: () => [retPtr(mod.strcasecpy(cptr.decay(bufs[0]), cptr.decay(bufs[1]))), pbuf(0)],
  str_start_is: ([, , f]) => [retInt(mod.str_start_is(cptr.decay(bufs[0]), cptr.decay(bufs[1]), Number(f)))],
  str_end_is: () => [retInt(mod.str_end_is(cptr.decay(bufs[0]), cptr.decay(bufs[1])))],
  strncmpi: ([, , n]) => [retInt(mod.strncmpi(cptr.decay(bufs[0]), cptr.decay(bufs[1]), Number(n)))],
  strstri: () => [retPtr(mod.strstri(cptr.decay(bufs[0]), cptr.decay(bufs[1])))],
  fuzzymatch: ([, , , f]) => [retInt(mod.fuzzymatch(cptr.decay(bufs[0]), cptr.decay(bufs[1]), cptr.decay(bufs[2]), Number(f)))],
  stripchars: () => [retPtr(mod.stripchars(cptr.decay(bufs[0]), cptr.decay(bufs[1]), cptr.decay(bufs[2]))), pbuf(0)],
  strsubst: () => [retPtr(mod.strsubst(cptr.decay(bufs[0]), cptr.decay(bufs[1]), cptr.decay(bufs[2]))), pbuf(0)],
  strNsubst: ([, , , n]) => [retInt(mod.strNsubst(cptr.decay(bufs[0]), cptr.decay(bufs[1]), cptr.decay(bufs[2]), Number(n))), pbuf(0)],
  findword: ([, , len, ic]) => [retPtr(mod.findword(cptr.decay(bufs[0]), cptr.decay(bufs[1]), Number(len), Number(ic)))],
  ordin: ([n]) => [retPtr(mod.ordin(Number(n)))],
  sitoa: ([n]) => [retPtr(mod.sitoa(Number(n)))],
  sgn: ([n]) => [retInt(mod.sgn(Number(n)))],
  isqrt: ([n]) => [retInt(mod.isqrt(Number(n)))],
  distmin: (a) => [retInt(mod.distmin(...a.map(Number)))],
  dist2: (a) => [retInt(mod.dist2(...a.map(Number)))],
  online2: (a) => [retInt(mod.online2(...a.map(Number)))],
  swapbits: (a) => [retInt(mod.swapbits(...a.map(Number)))],
  case_insensitive_comp: () => [retInt(mod.case_insensitive_comp(cptr.decay(bufs[0]), cptr.decay(bufs[1])))],
  unicodeval_to_utf8str: ([u, sz]) => [retInt(mod.unicodeval_to_utf8str(Number(u), cptr.decay(bufs[0]), BigInt(Number(sz)))), pbuf(0)],
  nh_snprintf: (a, idx) => {
    const cases = [
      () => mod.nh_snprintf(cptr.lit('battery'), 1, cptr.decay(bufs[0]), 32n, cptr.lit('%d|%s'), 42, cptr.lit('hi')),
      () => mod.nh_snprintf(cptr.lit('battery'), 2, cptr.decay(bufs[0]), 8n, cptr.lit('%d|%s'), 42, cptr.lit('hi')),
      () => mod.nh_snprintf(cptr.lit('battery'), 3, cptr.decay(bufs[0]), 4n, cptr.lit('%s'), cptr.lit('a longer string')),
      () => mod.nh_snprintf(cptr.lit('battery'), 4, cptr.decay(bufs[0]), 64n, cptr.lit('+%d %c %%'), 7, 113),
    ];
    cases[idx]();
    return [pbuf(0)];
  },
  nh_deterministic_qsort: (a, idx) => {
    if (idx === 0) {
      const data = new Uint8Array(14 * 4);
      mod.nh_deterministic_qsort(cptr.decay(data), 14n, 4n, null);
      return ['RET int:0'];
    }
    const vals = [5, 3, 3, 1, 4, 2, 8, 3, 0, -7, 3, 100, -100, 6];
    const data = new Uint8Array(14 * 4);
    vals.forEach((v, i) => cptr.stI32({ buf: data, off: i * 4 }, v));
    mod.nh_deterministic_qsort(cptr.decay(data), BigInt(vals.length), 4n, intcmp);
    return [`DATA ${hexBytes(data)}`];
  },
  copy_bytes: ([len]) => {
    len = Number(len);
    const content = new Uint8Array(len);
    for (let j = 0; j < len; j++) content[j] = (j * 7 + 3) & 0xFF;
    const fdr = cptr.fdNew(content, 'r');
    const fdw = cptr.fdNew([], 'w');
    const r = mod.copy_bytes(fdr, fdw);
    return [retInt(r), `DATA ${hexBytes(cptr.fdWritten(fdw))}`];
  },
  datamodel: ([i]) => [retPtr(mod.datamodel(Number(i)))],
  what_datamodel_is_this: (a) => [retPtr(mod.what_datamodel_is_this(...a.map(Number)))],
};

// single-string in-place functions: IN hex -> buf0; RET ptr + BUF0
for (const fn of ['lcase', 'ucase', 'upstart', 'upwords', 'mungspaces', 'trimspaces', 'strip_newline', 'stripdigits', 'tabexpand']) {
  DISPATCH[fn] = () => [retPtr(mod[fn](cptr.decay(bufs[0]))), pbuf(0)];
}

// tabexpand special markers from the C transcript
const SPECIAL_IN = {
  'tabexpand:900': () => bufs[0].fill(0x09, 0, 40),
  'tabexpand:901': () => bufs[0].fill(0x61, 0, 300),
};

// ---- parse transcript, replay, diff ----
const lines = transcript.split('\n');
let cur = null; // {fn, idx, args, expected[], hexArgs[]}
let failures = 0, total = 0;
const mismatches = [];


// argument decoding needs per-fn arg kinds (hex string vs int) — declared here
// (mirrors the C driver's IN lines)
const ARGKINDS = {
  digit: 'i', letter: 'i', highc: 'i', lowc: 'i', visctrl: 'i', chrcasecpy: 'ii',
  lcase: 's', ucase: 's', upstart: 's', upwords: 's', mungspaces: 's', trimspaces: 's',
  strip_newline: 's', stripdigits: 's', tabexpand: 's', eos: 's', c_eos: 's', onlyspace: 's',
  str_lines_maxlen: 's', s_suffix: 's', ing_suffix: 's',
  xcrypt: 's', strkitten: 'si', copynchars: 'si', strcasecpy: 'ss',
  str_start_is: 'ssi', str_end_is: 'ss', strncmpi: 'ssi', strstri: 'ss', fuzzymatch: 'sssi',
  stripchars: 's1s2', strsubst: 'sss', strNsubst: 'sssi', findword: 'ssii',
  ordin: 'i', sitoa: 'i', sgn: 'i', isqrt: 'i', distmin: 'iiii', dist2: 'iiii', online2: 'iiii',
  swapbits: 'iii', case_insensitive_comp: 'ss', unicodeval_to_utf8str: 'ii',
  nh_snprintf: 'fixed', nh_deterministic_qsort: 'fixed', copy_bytes: 'i',
  datamodel: 'i', what_datamodel_is_this: 'iiiiii',
};

function runCase(c) {
  total++;
  resetBufs();
  const kinds = ARGKINDS[c.fn];
  if (!kinds || !DISPATCH[c.fn]) { failures++; mismatches.push({ c, err: 'no dispatch' }); return; }
  if (SPECIAL_IN[`${c.fn}:${c.idx}`]) {
    SPECIAL_IN[`${c.fn}:${c.idx}`]();
  } else {
    let bi = 0, ai = 0;
    for (let k = 0; k < kinds.length && ai < c.args.length; k++) {
      if (kinds[k] !== 's') { ai++; continue; }
      // 's' fills buffers in order; 's0'/'s1'/'s2' pin to a specific buffer
      let bufIdx;
      if (kinds[k + 1] >= '0' && kinds[k + 1] <= '9') { bufIdx = Number(kinds[k + 1]); k++; }
      else bufIdx = bi++;
      unhex(c.args[ai++], bufs[bufIdx]);
    }
  }
  let got;
  try {
    got = DISPATCH[c.fn](c.args, Number(c.idx));
  } catch (err) {
    failures++;
    mismatches.push({ c, err: String(err.stack || err) });
    return;
  }
  if (got.join('\n') !== c.expected.join('\n')) {
    failures++;
    mismatches.push({ c, got });
  }
}

for (let li = 0; li < lines.length; li++) {
  const m = lines[li].match(/^# (\S+) (\d+)$/);
  if (!m) continue;
  const c = { fn: m[1], idx: m[2], args: [], expected: [] };
  li++;
  if (lines[li]?.startsWith('IN ')) {
    c.args = lines[li].slice(3).split(' ');
    li++;
  }
  while (li < lines.length && /^(RET|BUF|DATA)/.test(lines[li])) {
    c.expected.push(lines[li]);
    li++;
  }
  li--;
  runCase(c);
}

console.log(`cases: ${total}, failures: ${failures}`);
for (const mm of mismatches.slice(0, 10)) {
  console.log(`--- ${mm.c.fn} case ${mm.c.idx} (IN ${mm.c.args.join(' ')})`);
  if (mm.err) console.log(`    error: ${mm.err.split('\n')[0]}`);
  else {
    console.log(`    C : ${mm.c.expected.join(' | ')}`);
    console.log(`    JS: ${mm.got.join(' | ')}`);
  }
}
process.exit(failures ? 1 : 0);
