#!/usr/bin/env node
// loadgen.mjs — burn N cores for S seconds, so a bench can be taken on a
// machine that is busy the way the judge's container is busy.
//
// tools/judge-sim/playability.mjs --cpu-throttle=<n> slows the *page* target
// and cannot slow a worker (Chrome's Emulation domain is not available on
// dedicated, shared or service worker targets), so a throttled run handicaps
// the main-thread engine and leaves the worker transports at full speed. This
// is the unbiased complement: it contends for the same cores as every target
// in the browser at once, which is what a small container actually does.
//
//   node tools/judge-sim/loadgen.mjs --workers=8 --seconds=60
//
// Nothing here is shipped code and nothing imports it; it exists so the
// numbers in docs/NOTES-async-engine.md can say which machine they were taken
// on. Prints one line to stderr when it starts and one when it stops, so a
// bench log records that the load was really there.

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import os from 'node:os';

if (isMainThread) {
    const arg = (n, d) => {
        const a = process.argv.slice(2).find((x) => x.startsWith('--' + n + '='));
        return a ? Number(a.slice(n.length + 3)) : d;
    };
    const workers = arg('workers', Math.max(1, os.cpus().length - 2));
    const seconds = arg('seconds', 60);
    const until = Date.now() + seconds * 1000;
    process.stderr.write(`[loadgen] ${workers} busy threads for ${seconds}s on ${os.cpus().length} cores\n`);
    const pool = [];
    for (let i = 0; i < workers; i++) pool.push(new Worker(new URL(import.meta.url), { workerData: { until } }));
    let left = pool.length;
    for (const w of pool) w.on('exit', () => { if (--left === 0) process.stderr.write('[loadgen] done\n'); });
} else {
    // A loop the optimiser cannot delete: the accumulator escapes at the end.
    let x = 1;
    while (Date.now() < workerData.until) {
        for (let i = 0; i < 2e6; i++) x = (x * 1103515245 + 12345) % 2147483647;
    }
    if (x === -1) process.stderr.write('');
}
