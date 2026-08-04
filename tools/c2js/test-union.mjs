#!/usr/bin/env node
// test-union.mjs — gate B proof: the transpiled union_gate fixture produces
// byte-identical output (including union type-punning results) vs the
// natively compiled C. See fixtures/union_gate.c for the covered shapes
// (Lua Value/TValue, NetHack str_or_len, byte-view unions).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(repoRoot, '.cache/c2js/build');
const FIXTURE = path.join(repoRoot, 'tools/c2js/fixtures/union_gate.c');
const BIN = path.join(BUILD, 'union_gate');

fs.mkdirSync(BUILD, { recursive: true });
if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(FIXTURE).mtimeMs) {
  execFileSync('clang', [FIXTURE, '-o', BIN], { stdio: 'inherit' });
}
const cTrace = execFileSync(BIN, [], { encoding: 'utf8' });

execFileSync('node', [path.join(repoRoot, 'tools/c2js/ast-dump.mjs'), FIXTURE], { stdio: 'inherit' });
execFileSync('node', [path.join(repoRoot, 'tools/c2js/build.mjs'), 'union_gate'], { stdio: 'inherit' });
const jsModUrl = new URL(`file://${path.join(repoRoot, 'js/generated/union_gate.js')}`).href;
const jsTrace = execFileSync('node', ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(jsModUrl)}); m.main();`],
  { encoding: 'utf8', cwd: repoRoot });

if (jsTrace === cTrace) {
  console.log(`PASS union gate: output identical (${cTrace.split('\n').length - 1} lines)`);
  process.exit(0);
}
console.log('FAIL union gate: output differs');
const cl = cTrace.split('\n'), jl = jsTrace.split('\n');
for (let i = 0; i < Math.max(cl.length, jl.length); i++) {
  if (cl[i] !== jl[i]) console.log(`  line ${i + 1}:\n    C : ${cl[i]}\n    JS: ${jl[i]}`);
}
process.exit(1);
