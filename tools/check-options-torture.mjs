#!/usr/bin/env node
// check-options-torture.mjs — validate a recorded options-torture session
// against the checkpoints emitted by tools/gen-options-torture.mjs.
//
//   node tools/check-options-torture.mjs <recording.json> <recipe.expect.json>
//
// Every checkpoint says "after N keys, the rendered screen must contain T".
// A failure means the key stream desynced from the menus somewhere at or
// before that step — the first failure is the one worth looking at.
import { promises as fs } from 'node:fs';

const plain = (s) => (s || '')
    .replace(/\x1b\[(\d+)C/g, (_, k) => ' '.repeat(+k))
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\x0e\x0f]/g, '');

const rec = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const checks = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
const seg = rec.segments[0];
const expSteps = (seg.moves || '').length + 1;

let bad = 0;
if (seg.steps.length !== expSteps) {
    console.log(`TRUNCATED: got ${seg.steps.length} steps, expected ${expSteps}`);
    bad++;
}
for (const c of checks) {
    const st = seg.steps[c.step];
    if (!st) { console.log(`MISS step ${c.step}: no such step (want ${JSON.stringify(c.text)})`); bad++; continue; }
    if (!plain(st.screen).includes(c.text)) {
        console.log(`FAIL step ${c.step} key=${JSON.stringify(st.key)}: want ${JSON.stringify(c.text)}`);
        if (bad < 3) {
            for (const [i, l] of plain(st.screen).split('\n').entries()) {
                const t = l.replace(/\s+$/, '');
                if (t) console.log(`   ${String(i).padStart(2)}|${t}`);
            }
        }
        bad++;
    }
}
console.log(bad === 0
    ? `OK: ${checks.length} checkpoints, ${seg.steps.length} steps`
    : `${bad} problem(s) over ${checks.length} checkpoints`);
process.exit(bad ? 1 : 0);
