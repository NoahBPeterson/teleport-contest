#!/usr/bin/env node
// test-rnd.mjs — parity driver for the transpiled rnd.c.
//
// Replays the recorded PRNG call sequence of a session through
// js/generated/rnd.js and verifies every logged value, in order.
//
// Key structural fact about the recorder format (verified against the data):
// the log contains EVERY rn2/rnd/rnl/rne/rnz/d call, INCLUDING internal ones
// — rnz(25) logs as the four lines rn2(1000), rn2(4)[, ...], rne(4), rn2(2),
// rnz(25), all sharing the outer caller's " @ func(file:line)" annotation.
// So the driver cannot just drive every entry: it first reduces internal
// subtrees into their wrapper calls (annotation- and shape-guided), then
// drives only the outermost calls. The emitted module regenerates the
// internal entries itself; full-sequence comparison against the recording
// verifies every value, internal and public alike.
//
// rne/rnz read u.ulevel; both sessions' rne/rnz calls happen on the
// ulevel<15 branch (utmp=5), the prelude stub's default.
// Display-rng entries would be tagged "~drn2"; neither session has any.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SESSIONS = [
  'sessions/seed8000-tourist-starter.session.json',
  'sessions/seed0900-tourist-explore-actions.session.json',
];

const RNG_CALL = /^(?:rn2|rnd|rn1|rnl|rne|rnz|d)\(/;
const ENTRY = /^([a-z0-9_]+)\(([^)]*)\)=(-?\d+)$/;

function flatten(sessionFile) {
  const s = JSON.parse(fs.readFileSync(path.join(repoRoot, sessionFile), 'utf8'));
  const entries = [];
  for (const seg of s.segments || []) {
    for (const step of seg.steps || []) {
      for (const raw of step.rng || []) {
        const str = String(raw);
        const norm = str.replace(/\s*@\s.*$/, '').replace(/^\d+\s+/, '').trim();
        if (!RNG_CALL.test(norm)) continue;
        const m = norm.match(ENTRY);
        if (!m) throw new Error(`unparseable rng entry: ${str}`);
        const note = (str.match(/\s*@\s(.*)$/) || [])[1] || '';
        entries.push({ norm, fn: m[1], args: m[2].length ? m[2].split(',').map(Number) : [], val: Number(m[3]), note });
      }
    }
  }
  return { seed: s.segments[0].seed, entries };
}

// Reduce internal subtrees into their wrapper calls. Children immediately
// precede the wrapper entry and share its caller annotation.
function reduceTrees(entries) {
  const stack = [];
  for (const e of entries) {
    stack.push({ ...e, children: [] });
    const top = stack[stack.length - 1];
    if (top.fn === 'rne') {
      let k = 0;
      while (stack.length - 2 - k >= 0) {
        const c = stack[stack.length - 2 - k];
        if (c.fn === 'rn2' && c.children.length === 0 && c.note === top.note && c.args.join() === top.args.join()) k++;
        else break;
      }
      if (k >= 1) top.children = stack.splice(stack.length - 1 - k, k);
    } else if (top.fn === 'rnz') {
      if (stack.length >= 4) {
        const [a, b, c] = stack.slice(-4, -1);
        if (a.fn === 'rn2' && a.args[0] === 1000 && a.children.length === 0 &&
            b.fn === 'rne' && b.args[0] === 4 &&
            c.fn === 'rn2' && c.args[0] === 2 && c.children.length === 0 &&
            a.note === top.note && b.note === top.note && c.note === top.note) {
          top.children = stack.splice(stack.length - 4, 3);
        }
      }
    } else if (top.fn === 'rnl') {
      const below = stack[stack.length - 2];
      if (below && below.fn === 'rn2' && below.children.length === 0 && below.note === top.note) {
        top.children = stack.splice(stack.length - 2, 1);
      }
    }
    // d() draws via the static RND() which never logs — no children to reduce.
  }
  return stack;
}

async function replay(sessionFile, index) {
  // fresh module instance per session (own RNG state + log)
  const mod = await import(pathToFileURL(path.join(repoRoot, 'js/generated/rnd.js')).href + `?s=${index}`);
  const { seed, entries } = flatten(sessionFile);
  const trees = reduceTrees(entries);
  const internal = entries.length - trees.length;

  mod.rng_log_init(); // opens the (in-memory) log, like the C main does
  mod.init_isaac64(BigInt(seed), mod.rn2); // CORE context, seed as BigInt

  let firstMismatch = null;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    let got;
    try {
      got = Number(mod[t.fn](...t.args));
    } catch (err) {
      firstMismatch = { tree: i, entry: t.norm, error: String(err.stack || err) };
      break;
    }
    if (got !== t.val) {
      firstMismatch = { tree: i, entry: t.norm, expected: t.val, got };
      break;
    }
  }

  // full-sequence check: module log (annotations stripped) vs recording
  const log = mod.getRngLog().map((l) => l.replace(/\s*@\s.*$/, '').trim());
  let matched = 0;
  while (matched < entries.length && matched < log.length && log[matched] === entries[matched].norm) matched++;
  if (!firstMismatch && matched < entries.length) {
    firstMismatch = { seqIndex: matched, entry: entries[matched].norm, got: log[matched] };
  }

  return { sessionFile, seed, total: entries.length, matched, trees: trees.length, internal, firstMismatch };
}

let ok = true;
for (let i = 0; i < SESSIONS.length; i++) {
  const r = await replay(SESSIONS[i], i);
  const status = r.matched === r.total && !r.firstMismatch ? 'PASS' : 'FAIL';
  if (status === 'FAIL') ok = false;
  console.log(`${status} ${path.basename(r.sessionFile)}: ${r.matched}/${r.total}` +
    ` (${r.trees} outermost calls driven, ${r.internal} internal entries auto-verified)`);
  if (r.firstMismatch) {
    const fm = r.firstMismatch;
    console.log(`  first mismatch: ${JSON.stringify(fm)}`);
    const { entries } = flatten(r.sessionFile);
    const at = fm.seqIndex ?? 0;
    for (let j = Math.max(0, at - 4); j <= Math.min(entries.length - 1, at + 1); j++) {
      console.log(`    ${j === at ? '>>' : '  '} [${j}] ${entries[j].norm} @ ${entries[j].note}`);
    }
  }
}
process.exit(ok ? 0 : 1);
