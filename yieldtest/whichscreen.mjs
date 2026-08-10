#!/usr/bin/env node
// whichscreen.mjs — locate and print the cells where one engine's screens
// diverge from the recorded C session, using the same decoder the scorer uses.
//
//   node yieldtest/whichscreen.mjs <session.json> [--engine=sync|yield]
//
// Written for the yieldable-build investigation: the parity runner reports
// "Screen 1992/1997" and this says which five, and what changed in them.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeScreen, diffCell, ROWS_24, COLS_80 } from '../frozen/screen-decode.mjs';
import { normalizeSession } from '../frozen/session_loader.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const engine = (args.find((a) => a.startsWith('--engine=')) || '--engine=yield').split('=')[1];
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: whichscreen.mjs <session.json> [--engine=sync|yield]'); process.exit(2); }

const entry = engine === 'sync' ? 'js/jsmain.js' : 'js/jsmain-yield.mjs';
const { runSegment } = await import(path.join(repoRoot, entry));

import { readFileSync } from 'node:fs';
const session = normalizeSession(JSON.parse(readFileSync(path.resolve(repoRoot, file), 'utf8')));

// same Map-backed storage handle the runner builds, shared across segments
const map = new Map();
const storage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => { map.set(k, String(v)); },
  removeItem: (k) => { map.delete(k); },
  get length() { return map.size; },
  key: (i) => [...map.keys()][i] ?? null,
};

let screenIdx = 0;
let bad = 0;
for (const [segNo, seg] of session.segments.entries()) {
  const game = await runSegment({
    seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc || '',
    moves: seg.moves, storage,
  });
  const got = game.getScreens();
  const want = (seg.steps || []).filter((s) => s.screen).map((s) => s.screen);
  for (let i = 0; i < want.length; i++) {
    const a = decodeScreen(want[i]);
    const b = got[i] === undefined ? null : decodeScreen(got[i]);
    let diffs = [];
    if (!b) diffs.push('MISSING');
    else {
      for (let r = 0; r < ROWS_24; r++) {
        for (let c = 0; c < COLS_80; c++) {
          if (diffCell(a[r][c], b[r][c])) {
            diffs.push({ r, c, want: a[r][c], got: b[r][c] });
          }
        }
      }
    }
    if (diffs.length) {
      bad++;
      console.log(`\n--- segment ${segNo} step ${i} (global screen ${screenIdx}) : ${diffs.length} cells differ ---`);
      const rows = new Set(diffs.map((d) => d.r));
      for (const r of [...rows].slice(0, 4)) {
        console.log(`  row ${r}`);
        console.log(`   want |${a[r].map((x) => x.ch ?? ' ').join('')}|`);
        if (b) console.log(`   got  |${b[r].map((x) => x.ch ?? ' ').join('')}|`);
      }
      for (const d of diffs.slice(0, 8)) {
        console.log(`   (${d.r},${d.c}) want ${JSON.stringify(d.want)} got ${JSON.stringify(d.got)}`);
      }
      if (bad >= 4) { console.log('\n(stopping after 4 differing screens)'); process.exit(0); }
    }
    screenIdx++;
  }
  if (got.length !== want.length) {
    console.log(`segment ${segNo}: screen COUNT differs — recorded ${want.length}, engine ${got.length}`);
  }
}
console.log(bad ? `\n${bad} screens differ` : '\nall screens match');
