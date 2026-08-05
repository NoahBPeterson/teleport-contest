// segment-spawn.mjs — the pre-Milestone-2 segment runner: one child process
// per segment (js/boot/worker.mjs).
//
// Kept only as a local debugging escape hatch (C2JS_SPAWN=1) and as a
// reference oracle when checking that in-process isolation
// (js/boot/isolation.mjs) really is equivalent to process isolation. It lives
// under tools/ rather than js/ on purpose: the judge sandboxes runSegment with
// `node --permission`, which forbids child processes, so nothing reachable
// from js/jsmain.js's normal path may import node:child_process.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../js/boot/worker.mjs');

/**
 * @param {{seed, datetime, nethackrc, moves, storage: object|null}} job
 *        `job.storage` is the judge's Web-Storage-shaped handle (or null).
 * @returns {Promise<object>} the worker's result record.
 */
export async function runSegmentInChild(job) {
    const childJob = { ...job, storage: null };
    if (job.storage) {
        const o = {};
        for (let i = 0; i < (job.storage.length || 0); i++) {
            const k = job.storage.key(i);
            if (k != null) o[k] = job.storage.getItem(k);
        }
        childJob.storage = o;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c2js-seg-'));
    const jobFile = path.join(tmp, 'job.json');
    const outFile = path.join(tmp, 'result.json');
    fs.writeFileSync(jobFile, JSON.stringify(childJob));
    const r = spawnSync('node', [WORKER, jobFile, outFile], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600000,
    });
    if (r.error) throw r.error;
    if (!fs.existsSync(outFile)) {
        throw new Error(`segment worker failed: ${(r.stderr || '').toString().slice(-800)}`);
    }
    const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (job.storage && res.storage) {
        for (const [k, v] of Object.entries(res.storage)) job.storage.setItem(k, v);
    }
    if (res.error) throw new Error(res.error);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return res;
}
