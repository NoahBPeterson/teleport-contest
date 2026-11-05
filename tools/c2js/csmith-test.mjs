#!/usr/bin/env node
// csmith-test.mjs — random well-defined C (Csmith) through the transpiler: each
// program must print the same checksum natively and as JS. Needs `csmith` and
// clang on PATH; exits 0 with a note if csmith isn't installed.
//
// Run from repo root:
//   node tools/c2js/csmith-test.mjs                 every class, fixed seeds
//   node tools/c2js/csmith-test.mjs pointers        one class
//   node tools/c2js/csmith-test.mjs pointers 2300-2323
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(repoRoot, 'tools/c2js/fixtures');
const WORK = path.join(repoRoot, '.cache/c2js/csmith');
fs.mkdirSync(WORK, { recursive: true });

const SMALL = ['--max-funcs', '3', '--max-block-depth', '3'];
const NO = (...xs) => xs.map((x) => `--no-${x}`);
const QUIET = NO('volatiles', 'volatile-pointers', 'packed-struct');
// a class turns on what the previous ones left off, so a failure names a feature
const CLASSES = {
  scalars: { seeds: [100, 129], args: [...QUIET, ...SMALL, ...NO('unions', 'bitfields', 'structs', 'pointers', 'arrays')] },
  arrays: { seeds: [2000, 2023], args: [...QUIET, ...SMALL, ...NO('unions', 'bitfields', 'structs', 'pointers')] },
  structs: { seeds: [2100, 2123], args: [...QUIET, ...SMALL, ...NO('unions', 'bitfields', 'pointers')] },
  bitfields: { seeds: [2200, 2223], args: [...QUIET, ...SMALL, ...NO('unions', 'pointers')] },
  pointers: { seeds: [2300, 2323], args: [...QUIET, ...SMALL, ...NO('unions', 'bitfields', 'structs', 'arrays')] },
  noUnions: { seeds: [2400, 2423], args: [...QUIET, ...SMALL, ...NO('unions')] },
  unions: { seeds: [2500, 2523], args: [...QUIET, ...SMALL] },
  volatiles: { seeds: [2600, 2623], args: [...NO('packed-struct'), ...SMALL] },
  packed: { seeds: [2700, 2723], args: [...SMALL] },
  full: { seeds: [2800, 2815], args: [] },
};

const hasCsmith = (() => { try { execFileSync('csmith', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!hasCsmith) { console.log('csmith not installed; skipping'); process.exit(0); }
const brewInclude = '/opt/homebrew/opt/csmith/include/csmith-2.3.0';
const INC = process.env.CSMITH_INCLUDE || brewInclude;

const run = (cmd, args, { env, timeout = 60000, cwd = repoRoot } = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], err = [];
  const t = setTimeout(() => p.kill('SIGKILL'), timeout);
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.on('data', (d) => err.push(d));
  p.on('close', (code, sig) => { clearTimeout(t); resolve({ code: sig ? -1 : code, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString() }); });
});

// expand csmith's own "..." headers in place, so the program stands alone
function inline(file) {
  const seen = (f) => fs.readFileSync(f, 'latin1').split('\n').map((l) => {
    const m = /^\s*#\s*include\s+"([^"]+)"/.exec(l);
    const inc = m && path.join(INC, m[1]);
    return inc && fs.existsSync(inc) ? seen(inc) : l;
  }).join('\n');
  return `#define _FORTIFY_SOURCE 0\n${seen(file)}`;
}

/** @returns {Promise<string>} SAME, a reason it couldn't be tried (SKIP ...), or a failure */
async function one(cls, seed, args) {
  const name = `csm_${cls}_${seed}`;
  const raw = path.join(WORK, `${name}.raw.c`), src = path.join(FIX, `${name}.c`), bin = path.join(WORK, name);
  const clean = () => {
    for (const f of [src, `js/generated/${name}.js`, `js/generated-y/${name}.js`, `.cache/c2js/ast/${name}.ast.json`, `.cache/c2js/ast/${name}.ast.json.src`, raw, bin]) fs.rmSync(path.resolve(repoRoot, f), { force: true });
  };
  try {
    if ((await run('csmith', ['--seed', String(seed), '--output', raw, ...args], { cwd: WORK, timeout: 20000 })).code) return 'SKIP generator';
    fs.writeFileSync(src, inline(raw), 'latin1');
    // UBSan: a program whose C is itself undefined proves nothing
    if ((await run('clang', ['-w', '-O0', '-fsanitize=undefined', '-fno-sanitize-recover=undefined', src, '-o', bin])).code) return 'SKIP clang';
    const c = await run(bin, [], { timeout: 10000 });
    if (c.code) return 'SKIP native run (timeout or UB)';
    await run('node', ['tools/c2js/ast-dump.mjs', src]);
    const built = await run('node', ['tools/c2js/build.mjs', name], { env: { NODE_OPTIONS: '--max-old-space-size=2000' }, timeout: 120000 });
    if (built.code) return `REJECT ${built.err.split('\n').find((l) => /Error/.test(l))?.slice(0, 120)}`;
    const js = `const w=process.stdout.write.bind(process.stdout);process.stdout.write=()=>true;
      const {runBootGame}=await import('file://${repoRoot}/js/boot/harness.mjs');
      await runBootGame({stdoutSink: (s) => process.stdout.write(Buffer.from(s, 'latin1')), seed:1,datetime:'20260715120000',moves:'',nethackrc:'OPTIONS=name:X,role:Valkyrie,race:human,gender:female,align:lawful\\n'});
      process.stdout.write=w;const m=await import('file://${repoRoot}/js/generated/${name}.js');globalThis.__standaloneMain(m.main);`;
    const j = await run('node', ['--input-type=module', '-e', js], { timeout: 60000 });
    if (j.code === -1) return 'SKIP JS too slow';
    if (j.out === c.out) return 'SAME';
    return `DIFF C:${c.out.trim().split('\n').pop()} JS:${j.out.trim().split('\n').pop()} ${j.err.split('\n').find((l) => /Error/.test(l))?.slice(0, 100) ?? ''}`;
  } finally { clean(); }
}

const [only, range] = process.argv.slice(2);
const picked = only ? { [only]: CLASSES[only] } : CLASSES;
const jobs = [];
for (const [cls, { seeds, args }] of Object.entries(picked)) {
  const [lo, hi] = range ? range.split('-').map(Number) : seeds;
  for (let s = lo; s <= hi; s++) jobs.push({ cls, s, args });
}
const results = {};
let next = 0, bad = 0;
await Promise.all(Array.from({ length: Math.max(2, os.cpus().length - 2) }, async () => {
  while (next < jobs.length) {
    const { cls, s, args } = jobs[next++];
    const r = await one(cls, s, args);
    (results[cls] ||= { SAME: 0, SKIP: 0, fail: [] });
    if (r === 'SAME') results[cls].SAME++;
    else if (r.startsWith('SKIP')) { results[cls].SKIP++; (results[cls].why ||= {})[r] = (results[cls].why[r] || 0) + 1; }
    else { results[cls].fail.push(`${s} ${r}`); bad++; }
  }
}));
for (const [cls, r] of Object.entries(results)) {
  const why = Object.entries(r.why || {}).map(([k, n]) => `${n} ${k.slice(5)}`).join(', ');
  console.log(`${cls}: ${r.SAME} same, ${r.SKIP} skipped${why ? ` (${why})` : ''}, ${r.fail.length} failed`);
  for (const f of r.fail.sort()) console.log(`  ${f}`);
}
process.exit(bad ? 1 : 0);
