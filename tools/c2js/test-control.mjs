#!/usr/bin/env node
// test-control.mjs — the transpiled control_gate fixture produces
// byte-identical output vs the natively compiled C: C int truth values
// returned from integer functions, and goto-spliced breaks inside loops.
// See fixtures/control_gate.c.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(repoRoot, '.cache/c2js/build');
const FIXTURE = path.join(repoRoot, 'tools/c2js/fixtures/control_gate.c');
const BIN = path.join(BUILD, 'control_gate');

fs.mkdirSync(BUILD, { recursive: true });
if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(FIXTURE).mtimeMs) {
  execFileSync('clang', [FIXTURE, '-o', BIN], { stdio: 'inherit' });
}
const cTrace = execFileSync(BIN, [], { encoding: 'utf8' });

execFileSync('node', [path.join(repoRoot, 'tools/c2js/ast-dump.mjs'), FIXTURE], { stdio: 'inherit' });
execFileSync('node', [path.join(repoRoot, 'tools/c2js/build.mjs'), 'control_gate'], { stdio: 'inherit' });
const jsModUrl = new URL(`file://${path.join(repoRoot, 'js/generated/control_gate.js')}`).href;
const jsTrace = execFileSync('node', ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(jsModUrl)}); m.main();`],
  { encoding: 'utf8', cwd: repoRoot });

if (jsTrace === cTrace) {
  console.log(`PASS control gate: output identical (${cTrace.split('\n').length - 1} lines)`);
  process.exit(0);
}
console.log('FAIL control gate: output differs');
const cl = cTrace.split('\n'), jl = jsTrace.split('\n');
for (let i = 0; i < Math.max(cl.length, jl.length); i++) {
  if (cl[i] !== jl[i]) console.log(`  line ${i + 1}:\n    C : ${cl[i]}\n    JS: ${jl[i]}`);
}
process.exit(1);
