/**
 * Test runner for the printf the game runs (cptr.sprintfCore) using a JSONL case file.
 * Run from repo root: node test/printf.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sprintfCore, lit } from '../js/cptr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const caseFile = join(__dirname, '..', 'tools', 'c2js', 'fixtures', 'printf-cases.jsonl');

const lines = readFileSync(caseFile, 'utf8').split('\n').filter(Boolean);
let pass = 0;
const failures = [];

for (const line of lines) {
  const { n, fmt, args, expected } = JSON.parse(line);
  // a string argument is a C string, except %p's, which is the address it spells
  const cArgs = args.map((a) => (typeof a !== 'string' ? a : /^0x/.test(a) && /%p/.test(fmt) ? BigInt(a) : lit(a)));
  const got = sprintfCore(lit(fmt), cArgs);
  if (got !== expected) {
    failures.push({ n, fmt, args, expected, got });
  } else {
    pass++;
  }
}

const total = lines.length;
console.log(`printf tests: ${pass}/${total} passed`);
if (failures.length > 0) {
  console.error('Failures:');
  for (const f of failures) {
    console.error(`  #${f.n}: fmt="${f.fmt}" args=${JSON.stringify(f.args)} expected=${JSON.stringify(f.expected)} got=${JSON.stringify(f.got)}`);
  }
  process.exit(1);
} else if (total > 0) {
  console.log('All printf tests passed.');
}
