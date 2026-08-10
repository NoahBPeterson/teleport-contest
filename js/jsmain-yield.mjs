// jsmain-yield.mjs — runSegment against the YIELDABLE engine build.
//
// A parallel entry point, never imported by js/jsmain.js. The scored path
// (js/jsmain.js -> js/boot/harness.mjs -> js/generated/) is untouched; this
// one boots js/boot/harness-y.mjs -> js/generated-y/, where every function
// that can reach a keystroke read is a generator.
//
// Same contract as js/jsmain.js's runSegment, so the parity runner in
// yieldtest/ can be a verbatim copy of frozen/ps_test_runner.mjs with one
// import path changed.
//
// Node only. The browser rung uses js/boot/interactive.mjs instead; this file
// exists to answer one question — does the transformed engine still produce
// byte-identical sessions.

import { enableSegmentIsolation, segmentSpecifier } from './boot/isolation.mjs';
import { installBrowserGlobals } from './boot/browser-env.mjs';
import { TranspiledGame } from './jsmain.js';

const HARNESS_URL = new URL('./boot/harness-y.mjs', import.meta.url).href;

let segmentCount = 0;

export async function runSegment(input) {
    const n = ++segmentCount;
    const job = {
        seed: input.seed,
        datetime: input.datetime,
        nethackrc: input.nethackrc || '',
        moves: input.moves || '',
        storage: input.storage || null,
    };
    installBrowserGlobals();
    const isolated = await enableSegmentIsolation();
    const { runBootGame } = await import(segmentSpecifier(HARNESS_URL, n, isolated));
    const result = await runBootGame(job);
    if (result.error) throw result.error;
    return new TranspiledGame(result);
}

export { TranspiledGame };
