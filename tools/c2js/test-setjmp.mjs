#!/usr/bin/env node
// test-setjmp.mjs — gate A proof: the transpiled setjmp_gate fixture produces
// the identical control-flow trace as the natively compiled C.
//
// Steps: compile tools/c2js/fixtures/setjmp_gate.c (plain clang, system
// setjmp.h), run it; transpile via tools/c2js/build.mjs; run the emitted JS;
// diff the two traces byte-for-byte.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(repoRoot, '.cache/c2js/build');
const FIXTURE = path.join(repoRoot, 'tools/c2js/fixtures/setjmp_gate.c');
const BIN = path.join(BUILD, 'setjmp_gate');

fs.mkdirSync(BUILD, { recursive: true });
if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(FIXTURE).mtimeMs) {
  execFileSync('clang', [FIXTURE, '-o', BIN], { stdio: 'inherit' });
}
const cTrace = execFileSync(BIN, [], { encoding: 'utf8' });

// transpile (fresh AST only if the fixture changed) and run the JS side
execFileSync('node', [path.join(repoRoot, 'tools/c2js/ast-dump.mjs'), FIXTURE], { stdio: 'inherit' });
execFileSync('node', [path.join(repoRoot, 'tools/c2js/build.mjs'), 'setjmp_gate'], { stdio: 'inherit' });
const jsModUrl = new URL(`file://${path.join(repoRoot, 'js/generated/setjmp_gate.js')}`).href;
const jsTrace = execFileSync('node', ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(jsModUrl)}); m.main();`],
  { encoding: 'utf8', cwd: repoRoot });

if (jsTrace === cTrace) {
  console.log(`PASS setjmp gate: traces identical (${cTrace.split('\n').length - 1} lines)`);
  process.exit(0);
}
console.log('FAIL setjmp gate: traces differ');
const cl = cTrace.split('\n'), jl = jsTrace.split('\n');
for (let i = 0; i < Math.max(cl.length, jl.length); i++) {
  if (cl[i] !== jl[i]) console.log(`  line ${i + 1}:\n    C : ${cl[i]}\n    JS: ${jl[i]}`);
}
process.exit(1);
