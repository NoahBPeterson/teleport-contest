#!/usr/bin/env node
// js-mirror-run.mjs — one JS-side replay of the keys played so far, plus a
// parity verdict against what the C recorder produced for the same prefix.
//
// Used by tools/play-record.mjs to drive the right-hand pane. It is a
// separate, short-lived process on purpose:
//   - js/boot/harness.mjs consumes a whole move string per run (its input
//     queue is filled once at boot and "input exhausted" ends the segment),
//     so an incremental mirror means re-running the prefix. That is ~2-3 ms
//     per move here, i.e. well under a second for a normal play session.
//   - each run wants a fresh transpiled module graph (the generated modules
//     hold C file-scope state); js/jsmain.js runSegment already arranges
//     that via js/boot/isolation.mjs, and a fresh process makes it airtight
//     and leak-free.
//   - a crash, hang or OOM in the mirror cannot touch the recording.
//
// Usage: node tools/js-mirror-run.mjs <job.json>
//   job = { root, seed, datetime, nethackrc, moves, cStepsPath }
// Writes one JSON line to stdout:
//   { ok, moves, jsScreens, cSteps, rngJs, rngC, rngFirstDiff,
//     screenFirstDiff, match, screen, cursor, diffCells[], ms, error }
//
// The cell comparison uses frozen/screen-decode.mjs — the same decoder the
// judge's runner uses — but not the runner's full screensVisuallyEqual (it
// isn't exported). It is therefore a close approximation of the scored
// comparison, meant as a live signal, not as a verdict: `node
// frozen/ps_test_runner.mjs <file>` remains the authority.

import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const t0 = Date.now();
const job = JSON.parse(fsSync.readFileSync(process.argv[2], 'utf8'));
const root = job.root;

const isRngCall = (e) => typeof e === 'string' && /^(?:rn2|rnd|rn1|rnl|rne|rnz|d)\(/.test(e);
const normalizeRng = (e) => e.replace(/\s*@\s.*$/, '').replace(/^\d+\s+/, '').trim();

function readCSteps(p) {
    const out = [];
    let text = '';
    try { text = fsSync.readFileSync(p, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* torn last line: ignore */ }
    }
    return out;
}

function emit(doc) {
    process.stdout.write(JSON.stringify({ ...doc, ms: Date.now() - t0 }) + '\n');
}

try {
    const { decodeScreen, ROWS_24, COLS_80 } =
        await import(pathToFileURL(path.join(root, 'frozen', 'screen-decode.mjs')).href);
    const { runSegment } =
        await import(pathToFileURL(path.join(root, 'js', 'jsmain.js')).href);

    let game = null;
    let error = null;
    try {
        game = await runSegment({
            seed: job.seed, datetime: job.datetime,
            nethackrc: job.nethackrc, moves: job.moves,
        });
    } catch (e) {
        error = String((e && e.message) || e).slice(0, 300);
    }

    const jsScreens = game ? (game.getScreens?.() || []) : [];
    const jsCursors = game ? (game.getCursors?.() || []) : [];
    const jsRng = (game ? (game.getRngLog?.() || []) : [])
        .map((e) => (typeof e === 'string' ? e.replace(/^\d+\s+/, '') : String(e)))
        .filter(isRngCall);

    const cSteps = readCSteps(job.cStepsPath);
    const cRng = [];
    for (const s of cSteps) for (const e of (s.rng || [])) if (isRngCall(e)) cRng.push(e);

    let rngFirstDiff = null;
    for (let i = 0; i < Math.max(cRng.length, jsRng.length); i++) {
        if (normalizeRng(cRng[i] || '') !== normalizeRng(jsRng[i] || '')) { rngFirstDiff = i; break; }
    }

    const cellsEqual = (a, b) => (a.ch === b.ch && a.color === b.color
        && a.attr === b.attr && a.decgfx === b.decgfx);

    const n = Math.min(cSteps.length, jsScreens.length);
    let screenFirstDiff = null;
    for (let i = 0; i < n; i++) {
        const g1 = decodeScreen(cSteps[i].screen || '');
        const g2 = decodeScreen(jsScreens[i] || '');
        let same = true;
        for (let r = 0; r < ROWS_24 && same; r++) {
            for (let c = 0; c < COLS_80; c++) {
                if (!cellsEqual(g1[r][c], g2[r][c])) { same = false; break; }
            }
        }
        const cc = cSteps[i].cursor, jc = jsCursors[i];
        const curOk = !cc || (Array.isArray(jc) && cc[0] === jc[0] && cc[1] === jc[1]);
        if (!same || !curOk) { screenFirstDiff = i; break; }
    }

    // Cell-level diff for the newest frame both sides have, so the viewer can
    // point at exactly which glyphs disagree.
    const idx = n > 0 ? n - 1 : -1;
    const diffCells = [];
    if (idx >= 0) {
        const g1 = decodeScreen(cSteps[idx].screen || '');
        const g2 = decodeScreen(jsScreens[idx] || '');
        for (let r = 0; r < ROWS_24; r++) {
            for (let c = 0; c < COLS_80; c++) {
                if (!cellsEqual(g1[r][c], g2[r][c])) {
                    if (diffCells.length < 400) diffCells.push([r, c]);
                }
            }
        }
    }

    emit({
        ok: !error,
        error,
        moves: (job.moves || '').length,
        jsScreens: jsScreens.length,
        cSteps: cSteps.length,
        rngJs: jsRng.length,
        rngC: cRng.length,
        rngFirstDiff,
        screenFirstDiff,
        comparedSteps: n,
        match: !error && rngFirstDiff === null && screenFirstDiff === null,
        screen: idx >= 0 ? (jsScreens[idx] || '') : (jsScreens[jsScreens.length - 1] || ''),
        cursor: idx >= 0 ? (jsCursors[idx] || null) : null,
        cCursor: idx >= 0 ? (cSteps[idx].cursor || null) : null,
        diffCells,
    });
} catch (e) {
    emit({ ok: false, error: String((e && e.stack) || e).slice(0, 500) });
}
