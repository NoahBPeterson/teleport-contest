/**
 * Test runner for js/libc/printf.js using a JSONL case file.
 * Run from repo root: node test/printf.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sprintf } from '../js/libc/printf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const caseFile = join(__dirname, '..', 'tools', 'c2js', 'fixtures', 'printf-cases.jsonl');

const lines = readFileSync(caseFile, 'utf8').split('\n').filter(Boolean);
let pass = 0;
const failures = [];

for (const line of lines) {
  const { n, fmt, args, expected } = JSON.parse(line);
  const got = sprintf(fmt, ...args);
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
