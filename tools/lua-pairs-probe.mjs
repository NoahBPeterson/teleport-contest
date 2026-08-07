#!/usr/bin/env node
// lua-pairs-probe.mjs — is a library table's `pairs()` order observable?
//
// THE QUESTION S6 HAS TO ANSWER. Three tables in the two library scripts are
// hash parts rather than sequences, so `lua_next` visits them in an order that
// depends on where each string key lands in the node vector:
//
//   nhcore                        walked by nothing (l_nhcore_call uses
//                                 lua_getfield), but dumped by the oracle
//   nh_lua_variables              walked by table_stringify() at save time
//   nh_lua_variables._CB_<event>  walked by nh_callback_run() every turn the
//                                 tutorial is running
//
// §6.2 settled the same question for `questtext` by measurement rather than by
// argument: com_pager_core() builds a fresh nhl_init() state per message, so
// one run loaded quest.lua eight times and the *interpreter alone* produced
// eight different traversal orders. Nothing can depend on an order the
// reference implementation does not itself reproduce.
//
// gl.luacore is built once per game, so the eight-loads-in-one-run trick is not
// available for nhcore.lua. The equivalent is eight *runs*: luai_makeseed()
// (js/generated/lstate.js:34) mixes time(NULL) with pointer values, and the
// harness pins time() from the session's `datetime`, so varying the datetime
// varies g->seed exactly as a different allocation history would.
//
// This tool runs the interpreter alone — C2JS_LUA_PORT=0, no port anywhere —
// at N datetimes and prints, per run, the state's seed and the raw lua_next key
// order of each library table. If the orders differ, the order is a property of
// the seed and not of the data, and no port has to reproduce it.
//
// Usage:
//   node tools/lua-pairs-probe.mjs [--runs 8] [--seed 8123] [--rc '<text>']

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enableSegmentIsolation, segmentSpecifier } from '../js/boot/isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = pathToFileURL(path.join(ROOT, 'js/boot/harness.mjs')).href;

let segCounter = 0;

async function run(seg, env) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
        const { runBootGame } = await import(segmentSpecifier(HARNESS, ++segCounter, true));
        return await runBootGame({ ...seg, stdoutSink: () => {} });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const get = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
    if (!(await enableSegmentIsolation())) {
        console.error('lua-pairs-probe: segment isolation unavailable');
        process.exit(2);
    }
    const runs = Number(get('--runs', '8'));
    const seed = get('--seed', '8123');
    const rc = (get('--rc', '') || '').replace(/\\n/g, '\n');
    const moves = get('--moves', 'jjjllllkkkhhh   ');

    // Both sides, so the port's orders can be read next to the interpreter's.
    for (const [label, env] of [
        ['interpreter', { C2JS_LUA_PORT: '0', C2JS_LUA_TRACE: '1', C2JS_LUA_GLOBALS: 'dump' }],
        ['port', { C2JS_LUA_PORT: '1', C2JS_LUA_TRACE: '0', C2JS_LUA_GLOBALS: 'dump' }],
    ]) {
        console.log(`\n=== ${label} ===`);
        const seen = new Map();
        for (let i = 0; i < runs; i++) {
            // A different pinned time() per run, i.e. a different luai_makeseed.
            const datetime = `2026040${1 + (i % 9)}0${9 + i}0000`.slice(0, 14);
            // eslint-disable-next-line no-await-in-loop
            const r = await run({ seed, datetime, moves, nethackrc: rc }, env);
            if (r.error) throw r.error;
            for (const l of r.luaLoads.filter((x) => x.globalsScript)) {
                for (const g of l.globals) {
                    if (!g.keys || g.keys.length === 0) continue;
                    const key = `${l.script}:${g.name}`;
                    const line = `${(g.order >>> 0).toString(16).padStart(8)}  ${g.keys.join(',')}`;
                    if (!seen.has(key)) seen.set(key, new Map());
                    const m = seen.get(key);
                    m.set(line, (m.get(line) ?? 0) + 1);
                }
            }
        }
        for (const [key, m] of seen) {
            console.log(`  ${key}: ${m.size} distinct order${m.size === 1 ? '' : 's'} in ${runs} runs`);
            for (const [line, n] of m) console.log(`    x${n}  ${line}`);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
