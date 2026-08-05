// jsmain.js — Contest entry point: runSegment for the judge harness.
//
// The judge calls runSegment(input) once per session segment with
// { seed, datetime, nethackrc, moves, storage } and reads back
// game.getScreens() / getRngLog() / getCursors() /
// getAnimationFramesByStep() to compare with C-recorded session data.
//
// The game is the clang-AST→JS transpiled NetHack 5.0 corpus
// (js/generated/*). Each segment runs in a fresh child process
// (js/boot/worker.mjs) so C module state never leaks across segments;
// cross-segment persistence flows through input.storage (the judge's
// Web-Storage-shaped handle) via the FS overlay. The original
// hand-written skeleton engine lives on under js/legacy/.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'boot/worker.mjs');

class TranspiledGame {
    constructor(result) {
        this._result = result;
    }
    getScreens() { return this._result.screens || []; }
    getCursors() { return this._result.cursors || []; }
    getRngLog() { return this._result.rngLog || []; }
    getAnimationFramesByStep() { return this._result.animFramesByStep || []; }
}

export async function runSegment(input) {
    const job = {
        seed: input.seed,
        datetime: input.datetime,
        nethackrc: input.nethackrc || '',
        moves: input.moves || '',
        storage: null,
    };
    if (input.storage) {
        const o = {};
        for (let i = 0; i < (input.storage.length || 0); i++) {
            const k = input.storage.key(i);
            if (k != null) o[k] = input.storage.getItem(k);
        }
        job.storage = o;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c2js-seg-'));
    const jobFile = path.join(tmp, 'job.json');
    const outFile = path.join(tmp, 'result.json');
    fs.writeFileSync(jobFile, JSON.stringify(job));
    const r = spawnSync('node', [WORKER, jobFile, outFile], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600000,
    });
    if (r.error) throw r.error;
    if (!fs.existsSync(outFile)) {
        throw new Error(`segment worker failed: ${(r.stderr || '').toString().slice(-800)}`);
    }
    const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (input.storage && res.storage) {
        for (const [k, v] of Object.entries(res.storage)) input.storage.setItem(k, v);
    }
    if (res.error) throw new Error(res.error);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return new TranspiledGame(res);
}

export { TranspiledGame as NethackGame };
