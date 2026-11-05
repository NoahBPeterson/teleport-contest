#!/usr/bin/env node
// test-gates.mjs — transpile the torture and generated-operator fixtures and
// require byte-identical output from native C and JS. Takes a couple of minutes
// and leaves no generated files behind.
//
// Run from repo root: node tools/c2js/test-gates.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(repoRoot, 'tools/c2js/fixtures');
const BUILD = path.join(repoRoot, '.cache/c2js/build');
fs.mkdirSync(BUILD, { recursive: true });
execFileSync('python3', [path.join(repoRoot, 'tools/c2js/gen_ops_gate.py'), FIX]);

const SHARDS = fs.readdirSync(FIX).filter((f) => /^ops_gate_\d+\.c$/.test(f)).map((f) => f.slice(0, -2));
// one-construct programs: each repro from docs/TICKETS-c2js.md, copied flat into
// fixtures/ just long enough to build, since the builder looks only there
const LANG = fs.readdirSync(path.join(FIX, 'lang')).filter((f) => f.endsWith('.c')).map((f) => `lang_${f.slice(0, -2)}`);
for (const n of LANG) fs.copyFileSync(path.join(FIX, 'lang', `${n.slice(5)}.c`), path.join(FIX, `${n}.c`));
const names = ['torture_gate', ...SHARDS, ...LANG];
const run = (cmd, args, env) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], err = [];
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.on('data', (d) => err.push(d));
  p.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString() }));
});

async function gate(name) {
  const src = path.join(FIX, `${name}.c`), bin = path.join(BUILD, name);
  execFileSync('clang', ['-w', src, '-o', bin]);
  const want = (await run(bin, [])).out;
  await run('node', ['tools/c2js/ast-dump.mjs', src]);
  const built = await run('node', ['tools/c2js/build.mjs', name], { NODE_OPTIONS: '--max-old-space-size=6000' });
  if (built.code) return `${name}: transpile failed: ${built.err.split('\n').find((l) => /Error/.test(l))}`;
  // torture_gate calls into libc the harness installs, so boot the port first
  const js = `
    const w = process.stdout.write.bind(process.stdout); process.stdout.write = () => true;
    const { runBootGame } = await import('file://${repoRoot}/js/boot/harness.mjs');
    await runBootGame({ stdoutSink: (s) => process.stdout.write(Buffer.from(s, 'latin1')), seed: 1, datetime: '20260715120000', moves: '',
      nethackrc: 'OPTIONS=name:X,role:Valkyrie,race:human,gender:female,align:lawful\\n' });
    process.stdout.write = w;
    const m = await import('file://${repoRoot}/js/generated/${name}.js'); globalThis.__standaloneMain(m.main);`;
  const got = await run('node', ['--input-type=module', '-e', js]);
  fs.rmSync(path.join(repoRoot, `js/generated/${name}.js`), { force: true });
  fs.rmSync(path.join(repoRoot, `js/generated-y/${name}.js`), { force: true });
  if (name.startsWith('lang_')) fs.rmSync(src, { force: true });
  for (const ext of ['ast.json', 'ast.json.src']) if (name.startsWith('lang_')) fs.rmSync(path.join(repoRoot, `.cache/c2js/ast/${name}.${ext}`), { force: true });
  if (got.out === want) return null;
  const a = want.split('\n'), b = got.out.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  return `${name}: line ${i + 1}: C ${JSON.stringify(a[i])} JS ${JSON.stringify(b[i])} ${got.err.split('\n').find((l) => /Error/.test(l)) ?? ''}`;
}

// bounded parallelism: the shards are heavy and the small programs many
const results = [];
for (let i = 0, queue = [...names]; queue.length; i++) {
  results.push(...await Promise.all(queue.splice(0, 8).map(gate)));
}
const bad = results.filter(Boolean);
for (const r of bad) console.log(`FAIL ${r}`);
console.log(`c2js gates: ${names.length - bad.length}/${names.length} passed`);
process.exit(bad.length ? 1 : 0);
