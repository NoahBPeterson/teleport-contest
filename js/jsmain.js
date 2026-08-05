// jsmain.js — Contest entry point: runSegment for the judge harness.
//
// The judge calls runSegment(input) once per session segment with
// { seed, datetime, nethackrc, moves, storage } and reads back
// game.getScreens() / getRngLog() / getCursors() /
// getAnimationFramesByStep() to compare with C-recorded session data.
//
// The game is the clang-AST→JS transpiled NetHack 5.0 corpus
// (js/generated/*). Everything runs in *this* process: the judge sandboxes
// us with `node --permission` (no child processes, no worker threads, no
// filesystem writes, reads confined to the fork tree), and the same code has
// to be able to run in a browser. So:
//
//   - per-segment isolation comes from js/boot/isolation.mjs, which forks a
//     fresh copy of the whole transpiled module graph per segment instead of
//     a fresh process (see that file for why the naive `?seg=` trick isn't
//     enough);
//   - the game's data files are vendored as JS modules under data/ and served
//     by an in-memory VFS in js/boot/harness.mjs — no real filesystem at all;
//   - cross-segment persistence flows through input.storage (the judge's
//     Web-Storage-shaped handle) via that VFS overlay.
//
// C2JS_SPAWN=1 restores the old one-child-process-per-segment path
// (tools/segment-spawn.mjs + js/boot/worker.mjs) for local debugging. It is
// deliberately not reachable from this file's module graph — the judge must
// never be able to take it.
//
// The original hand-written skeleton engine lives on under js/legacy/.

import { enableSegmentIsolation, segmentSpecifier } from './boot/isolation.mjs';

const HARNESS_URL = new URL('./boot/harness.mjs', import.meta.url).href;

let segmentCount = 0;
let spawnFallback;

class TranspiledGame {
    constructor(result) {
        this._result = result;
    }
    getScreens() { return this._result.screens || []; }
    getCursors() { return this._result.cursors || []; }
    getRngLog() { return this._result.rngLog || []; }
    getAnimationFramesByStep() { return this._result.animFramesByStep || []; }
}

function wantSpawn() {
    return typeof process !== 'undefined' && process.env && process.env.C2JS_SPAWN === '1';
}

export async function runSegment(input) {
    const n = ++segmentCount;
    const job = {
        seed: input.seed,
        datetime: input.datetime,
        nethackrc: input.nethackrc || '',
        moves: input.moves || '',
        storage: input.storage || null,
    };

    if (wantSpawn()) {
        // Debug escape hatch; lives outside js/ so the sandboxed path stays
        // free of node:child_process.
        if (!spawnFallback) {
            spawnFallback = await import(new URL('../tools/segment-spawn.mjs', import.meta.url).href);
        }
        return new TranspiledGame(await spawnFallback.runSegmentInChild(job));
    }

    const isolated = await enableSegmentIsolation();
    const { runBootGame } = await import(segmentSpecifier(HARNESS_URL, n, isolated));
    const result = await runBootGame(job);
    if (result.error) throw result.error;
    return new TranspiledGame(result);
}

export { TranspiledGame as NethackGame };
