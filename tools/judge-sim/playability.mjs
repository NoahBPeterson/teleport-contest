// playability.mjs — is the play page actually playable, in a real browser?
//
// ps_test_runner measures the *scoring* path. This measures the path a human
// takes: mirror-shaped server, real headless Chrome, real index.html, real
// keydown events, one at a time, timed from dispatch to painted frame.
//
//   node tools/judge-sim/playability.mjs [--coi] [--no-sw] [--keys=hjkl...]
//                                        [--inert-sw] [--sw-deny-dedicated]
//                                        [--hang-sw] [--judge-stub]
//                                        [--transport=worker|sharedworker|replay|main]
//                                        [--transport-delay=ms] [--key-delay=ms]
//                                        [--datetime=YYYYMMDDHHMMSS]
//                                        [--cpu-throttle=N] [--latency=ms]
//                                        [--viewer[=a.json,b.json]]
//                                        [--multigame[=N]] [--workerless]
//                                        [--seed=N] [--timeout=ms] [--keep]
//
// --no-sw additionally 404s js/sw.js, which leaves the page with no blocking
// transport at all and forces the ReplayEngine fallback. That is the path the
// judge's browser took, and the only way to measure it here.
//
// --transport=<rung> narrows the ladder in js/boot/interactive.mjs to one rung
// (see transportOverride() there). It can only ever *remove* rungs, so it
// cannot make a run pass that would not have passed anyway; it exists so each
// rung can be measured on its own.
//
// --coi serves COOP/COEP so the page is crossOriginIsolated and the engine
// blocks on Atomics.wait over a SharedArrayBuffer. Without it the server
// behaves like GitHub Pages (no COOP/COEP, no SharedArrayBuffer) and the
// engine has to get its keys through the service worker in js/sw.js — that is
// the configuration mazesofmenace.ai actually serves, so it is the default.
//
// Console output is collected two ways, because they see different things:
//
//   --enable-logging=stderr   what Chrome's own logger prints: console API
//                             calls and uncaught exceptions, page only.
//   CDP (Log + Runtime)       what a DevTools-protocol harness sees: the
//                             above *plus* network-level entries — a 404 on a
//                             subresource, a failed service-worker
//                             registration, a CSP violation — and it sees them
//                             in workers and service workers too, not just the
//                             page.
//
// The judge drives Chromium over CDP, so the second list is the one that
// decides whether "fails on any console output" fires. Everything this repo
// does on the transport ladder has to keep it empty.
//
// Chrome is located at the macOS default; override with CHROME=/path/to/chrome.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const a = args.find(x => x.startsWith('--' + name + '='));
    return a ? a.slice(name.length + 3) : dflt;
};
const coi = args.includes('--coi');
// --no-sw forces the page onto js/boot/interactive.mjs's ReplayEngine fallback
// (no SAB without --coi, and no service worker if its script 404s). Test-only:
// it measures the degraded path, which is the one the judge's browser hit.
const noSw = args.includes('--no-sw');
// --inert-sw serves a service worker that registers but intercepts nothing —
// the failure mode the ladder in js/boot/interactive.mjs is built around, and
// the only way to reproduce "the probe says no" without a browser that gets
// worker control wrong. See tools/judge-sim/server.mjs.
const inertSw = args.includes('--inert-sw');
// --sw-deny-dedicated stages the browser difference the ladder exists for: the
// service worker answers the interception probe truthfully for a SharedWorker
// and falsely for a dedicated worker, so rung 2 fails and rung 3 has to catch
// the game. See tools/judge-sim/server.mjs.
const denyDedicated = args.includes('--sw-deny-dedicated');
// --hang-sw serves a service worker that registers, activates, intercepts — and
// never answers. It is the failure the old serial ladder could not survive
// (every transport waiting out its own probe timeout before the next was tried)
// and the one the judge's "0 moves, no error, no console output" looks like.
const hangSw = args.includes('--hang-sw');
// --judge-stub wraps the page in a host shaped like the judge's own: a
// `process` stub claiming to be Node, and an import map aiming `node:*` at
// shims. Our environment checks used to believe it. See server.mjs.
const judgeStub = args.includes('--judge-stub');
const transport = opt('transport', '');
// --transport-delay=<ms> holds the transports back inside
// js/boot/interactive.mjs, so the ReplayEngine fallback demonstrably wins the
// boot race and the upgrade swap that follows can be measured on purpose. Only
// a test can ask for this, and all it can do is make the page slower.
const transportDelay = opt('transport-delay', '');
// --datetime=<YYYYMMDDHHMMSS> pins the clock NetHack starts from, so two runs
// can be compared screen-for-screen (the default is "now", which is not).
const datetime = opt('datetime', '');
// --part2=<ms> runs the two-phase shape the judge's browser check uses: load
// index.html and leave it alone for <ms> (their script-error/failed-fetch
// observation window), then build a NethackGame and drive it. --seed2=<n> gives
// that second phase a seed of its own, which is always the case for the judge:
// the page cannot know the session seed at load time. The number to read out of
// these runs is start_to_frame_ms, not first_frame_ms.
const part2 = opt('part2', '');
const seed2 = opt('seed2', '');
// --no-prewarm passes ?prewarm=0, which stops index.html warming an engine
// realm at page load. This is the floor a prewarm can never do worse than: it
// is what every run looked like before the prewarm existed, and it is the
// number a *discarded* prewarm would cost if one could be discarded.
const noPrewarm = args.includes('--no-prewarm');
// --shape-b drives the page the way a browser harness does, from OUTSIDE it:
// navigate, wait for a game frame WITHOUT sending anything, and only then send
// keys — over CDP Input.dispatchKeyEvent, so they arrive as real keydowns at
// the document, not as synthetic events the page dispatched to itself.
//
// This is the shape that produced "browser_ok, no error class, 0 moves in 88
// sessions". A page whose first frame was gated on display.readKey() deadlocks
// it outright: the harness waits for a frame that will never paint because it
// is waiting to be typed at. Every other mode in this file dispatches its own
// first key and can never see it. Run with --no-autoboot to watch it fail.
const shapeB = args.includes('--shape-b');
// --no-autoboot passes ?autoboot=0, which restores the page's old
// wait-for-a-key shape. It is the floor for every auto-boot measurement and the
// way --shape-b's failure is staged.
const noAutoboot = args.includes('--no-autoboot');
// --cpu-throttle=<n> slows every target Chrome will let us slow, via CDP
// Emulation.setCPUThrottlingRate, applied at attach time so it is in force
// before the target runs a line of script. It is the only way here to ask the
// question the judge's container asks: does this rung still paint in time on
// hardware several times slower than this laptop?
//
// Read the answer with care. The rate is honoured by *page* targets; Chrome's
// Emulation domain is not available on dedicated/shared/service workers, so a
// throttled run slows the main thread and leaves the worker transports at full
// speed. That biases the comparison AGAINST the main-thread engine — which is
// what makes it a useful number: a rung that wins while carrying the handicap
// has won. tools/judge-sim/loadgen.mjs is the unbiased complement.
const cpuThrottle = Number(opt('cpu-throttle', '0')) || 0;
// --latency=<ms> makes tools/judge-sim/server.mjs answer every request that much
// later, so the cost of *fetching* a module graph is priced instead of assumed.
// Loopback answers in microseconds; the mirror does not.
const latency = opt('latency', '');
const timeoutMs = Number(opt('timeout', '180000'));
const PORT = Number(opt('port', String(9500 + (process.pid % 400))));
// DevTools endpoint, kept clear of the range PORT is drawn from.
const DPORT = PORT + 1000;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'playability-'));
const logFile = path.join(work, 'requests.jsonl');
const resultFile = path.join(work, 'bench.json');
const chromeProfile = path.join(work, 'chrome-profile');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'),
    '--port', String(PORT), '--log', logFile, '--result', resultFile,
    ...(coi ? ['--coi'] : []), ...(noSw ? ['--no-sw'] : []), ...(inertSw ? ['--inert-sw'] : []),
    ...(denyDedicated ? ['--sw-deny-dedicated'] : []), ...(hangSw ? ['--hang-sw'] : []),
    ...(judgeStub ? ['--judge-stub'] : []), ...(latency ? ['--latency=' + latency] : [])],
    { stdio: ['ignore', 'inherit', 'inherit'] });

let up = false;
for (let i = 0; i < 100 && !up; i++) {
    await sleep(50);
    try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; } catch { /* not yet */ }
}
if (!up) { server.kill(); throw new Error('server never came up'); }

// Pin the character so the measurement happens in the dungeon, walking
// around, rather than in the chargen prompts (which are far cheaper per key
// and would flatter the number).
const DEFAULT_RC = [
    'OPTIONS=name:Bench', 'OPTIONS=role:Valkyrie', 'OPTIONS=race:human',
    'OPTIONS=gender:female', 'OPTIONS=align:neutral', 'OPTIONS=!tutorial',
    'OPTIONS=color,showexp,showscore,time', 'OPTIONS=runmode:walk',
].join('\n') + '\n';

// --shape-b runs the page with no bench at all: the driver below is the thing
// that types, and the page must be caught doing nothing until it does. ?shapeb=1
// only tells index.html that the URL is allowed to pin the character and the
// clock, which is otherwise a ?bench= privilege.
const q = shapeB
    ? new URLSearchParams({ shapeb: '1', seed: opt('seed', '8000'), rc: opt('rc', DEFAULT_RC) })
    : new URLSearchParams({ bench: '/__sim/result', seed: opt('seed', '8000'), rc: opt('rc', DEFAULT_RC) });
const keys = opt('keys', '');
if (keys) q.set('keys', keys);
if (transport) q.set('transport', transport);
if (transportDelay) q.set('transportdelay', transportDelay);
if (datetime) q.set('datetime', datetime);
if (part2) q.set('part2', part2);
if (seed2) q.set('seed2', seed2);
if (noPrewarm) q.set('prewarm', '0');
if (noAutoboot) q.set('autoboot', '0');
// --key-delay=<ms> paces the bench's keystrokes; see runBench() in index.html.
if (opt('key-delay', '')) q.set('keydelay', opt('key-delay', ''));
q.set('bmoves', opt('moves', '240'));
// --viewer drives tools/judge-sim/viewer-repro.html instead of the play page:
// ONE import of js/jsmain.js, then several sessions replayed back-to-back
// through it, which is how the judge's Session Viewer works and is the only
// thing here that exercises "a second game in a page that already ran one".
// Same browser, same console capture, different page.
const viewer = args.includes('--viewer') || !!opt('viewer', '');
// --multigame[=N] drives tools/judge-sim/multigame-repro.html: N *interactive*
// games built back-to-back in one page with no reload, which nothing else here
// can stage (index.html plays one game and reloads for the next). It is the
// only check on what happens after the main-thread rung has spent the page
// realm — the game-2 contract in js/boot/main-thread-engine.mjs.
const multigame = args.includes('--multigame') || !!opt('multigame', '');
const url = viewer
    ? `http://127.0.0.1:${PORT}/__sim/viewer-repro.html?sessions=${encodeURIComponent(opt('viewer',
        'seed0002-healer-reflection-drummer.session.json,seed0004-feeding-pony.session.json,'
        + 'seed0013-friday13-save-then-fullmoon-restore.session.json'))}`
    : multigame
        ? `http://127.0.0.1:${PORT}/__sim/multigame-repro.html?games=${opt('multigame', '2') || '2'}`
            + `&seed=${opt('seed', '8000')}&seed2=${opt('seed2', '4500')}&datetime=${opt('datetime', '20240101120000')}`
            + (keys ? `&keys=${encodeURIComponent(keys)}` : '')
            + (transport ? `&transport=${transport}` : '')
            + (args.includes('--workerless') ? '&workerless=1' : '')
        : `http://127.0.0.1:${PORT}/?${q}`;

process.stderr.write(`\n=== Headless Chrome: ${url} (COI ${coi ? 'on' : 'off'}) ===\n`);
// Start on about:blank and navigate over CDP instead of passing the URL on the
// command line: the Log/Runtime domains have to be enabled before the page runs
// a line of script, or the very first console entry — the one most likely to be
// the interesting one — is missed.
const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${chromeProfile}`,
    '--enable-logging=stderr',
    '--v=0',
    `--remote-debugging-port=${DPORT}`,
    'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d; });
chrome.stdout.on('data', d => { chromeErr += d; });

// --- CDP: console capture across every target -------------------------------
//
// One WebSocket to the *browser* endpoint, with flattened auto-attach turned on
// at every level: the page attaches to the browser session, its dedicated
// workers attach to the page session, and shared/service workers attach to the
// browser session. Each new session gets Log + Runtime enabled and its own
// auto-attach before it is released from the debugger pause, so nothing starts
// running unobserved.
async function cdpConnect(port) {
    let info = null;
    for (let i = 0; i < 200 && !info; i++) {
        try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }
        catch { await sleep(50); }
    }
    if (!info) throw new Error('devtools endpoint never came up');
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const targets = new Map();      // sessionId -> targetInfo
    const entries = [];
    let pageSid = null;
    let onPage = null;
    const whenPage = new Promise((res) => { onPage = res; });

    const call = (method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = ++nextId;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });

    const argText = (args) => (args || [])
        .map(a => (a.value !== undefined ? String(a.value) : (a.description || a.unserializableValue || a.type)))
        .join(' ');

    ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id !== undefined) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            if (p) (m.error ? p.rej(new Error(m.error.message)) : p.res(m.result));
            return;
        }
        if (m.method === 'Target.attachedToTarget') {
            const sid = m.params.sessionId;
            targets.set(sid, m.params.targetInfo);
            if (m.params.targetInfo.type === 'page' && !pageSid) { pageSid = sid; onPage(sid); }
            if (process.env.NHDEBUG) process.stderr.write(`[cdp] attached ${m.params.targetInfo.type} ${m.params.targetInfo.url}\n`);
            // Queue all four without awaiting. A target paused on start is
            // released by the last one, and awaiting the earlier replies would
            // leave it paused forever if any of them never answers — which is
            // exactly what a worker paused before its Runtime is up does.
            // Commands on one session are processed in the order they are sent,
            // so the enables still take effect before the target runs.
            for (const [method, params] of [
                ['Log.enable', {}],
                ['Runtime.enable', {}],
                ...(cpuThrottle > 1 ? [['Emulation.setCPUThrottlingRate', { rate: cpuThrottle }]] : []),
                ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
                ['Runtime.runIfWaitingForDebugger', {}],
            ]) call(method, params, sid).catch(() => { /* target gone, or not that kind of target */ });
            return;
        }
        // targetInfo.url is the URL at *attach* time (about:blank for the page
        // we navigate ourselves), so only the type is worth reporting; each
        // entry carries its own URL.
        const t = targets.get(m.sessionId);
        const where = t ? t.type : 'browser';
        // Log.entryAdded repeats console API calls with source 'console-api';
        // Runtime.consoleAPICalled already has those, with the arguments.
        if (m.method === 'Log.entryAdded' && m.params.entry.source !== 'console-api') {
            const e = m.params.entry;
            entries.push({ where, kind: `log/${e.source}/${e.level}`, text: e.text + (e.url ? ` <${e.url}>` : '') });
        } else if (m.method === 'Runtime.consoleAPICalled') {
            entries.push({ where, kind: 'console.' + m.params.type, text: argText(m.params.args) });
        } else if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            entries.push({ where, kind: 'exception', text: (d.text || '') + ' ' + ((d.exception && d.exception.description) || '') });
        }
    });

    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return { call, entries, whenPage, close: () => { try { ws.close(); } catch { /* already closed */ } } };
}

/**
 * Drive the page from outside it, the way a browser harness does.
 *
 * Phase one: navigate and WAIT FOR A GAME FRAME, sending nothing. What is being
 * asserted is that one paints — `keys_before_first_frame: 0` — because the
 * alternative is the deadlock this whole mode exists to catch.
 *
 * Phase two: send keys as real keydowns over Input.dispatchKeyEvent, and check
 * they are consumed by the game rather than queued into a page that is still
 * waiting to be started.
 *
 * The two timings it reports mean different things and are labelled that way.
 * `first_frame_ms` is the page's own clock (performance.now(), i.e. from
 * navigation start) and is directly comparable with every other mode here.
 * `ms_per_move` includes one CDP round trip per keystroke — the driver is on
 * the other side of a WebSocket — so it is an upper bound, and
 * `engine_ms_per_move`, taken on the engine thread, is the clean figure.
 */
async function driveShapeB(dev, sid, keyStream) {
    const evaluate = async (expression, awaitPromise = false) => {
        const r = await dev.call('Runtime.evaluate',
            { expression, awaitPromise, returnByValue: true }, sid);
        if (r.exceptionDetails) {
            throw new Error((r.exceptionDetails.text || 'evaluate failed') + ' '
                + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
        }
        return r.result && r.result.value;
    };

    // Phase one. Nothing is sent, on purpose. Bounded well under the run
    // timeout because "no frame" is an answer this mode is expected to get
    // (--no-autoboot), and it should not cost three minutes to hear it.
    const deadline = Date.now() + Math.min(timeoutMs, 20000);
    let first = null;
    while (Date.now() < deadline) {
        first = await evaluate(`(function(){
            if (!window.__NH || !window.__NH_FIRST_FRAME_MS) return null;
            var d = window.__NH.display;
            return { ms: Math.round(window.__NH_FIRST_FRAME_MS),
                     mode: window.__NH.engine && window.__NH.engine.mode,
                     frames: d.frames, keys_before: window.__NH_KEYS_AT_FIRST_FRAME || 0 };
        })()`);
        if (first) break;
        await sleep(50);
    }
    if (!first) {
        return { moves: 0, shape_b: true, first_frame_ms: 0,
                 error: 'no game frame ever painted, and nothing was typed — '
                      + 'this is the deadlock --shape-b exists to catch' };
    }

    // Phase two. One frame counter, read once per key, so a key that produced
    // no frame is visible as a stall rather than as a fast move.
    await evaluate(`window.__SB = { frames: 0, last: 0 };
        (function(){ var d = window.__NH.display;
            d.onFrame = function(){ window.__SB.frames++; window.__SB.last = performance.now(); }; })(); 0`);

    const times = [];
    for (let i = 0; i < keyStream.length; i++) {
        const ch = keyStream[i];
        const want = i + 1;
        const t0 = Date.now();
        await dev.call('Input.dispatchKeyEvent', {
            type: 'keyDown', text: ch, key: ch, unmodifiedText: ch,
            windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
            nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
        }, sid);
        let got = 0;
        while (Date.now() - t0 < 20000) {
            got = await evaluate('window.__SB.frames');
            if (got >= want) break;
            await sleep(2);
        }
        times.push(Date.now() - t0);
        if (got < want) break;
        if (await evaluate('!!(window.__NH && window.__NH.game && window.__NH.game.engine'
                           + ' && window.__NH.game.engine.gameover)')) break;
    }

    const tail = await evaluate(`(function(){
        var d = window.__NH.display, rows = [], r, c, s;
        for (r = 0; r < 24; r++) { s = ''; for (c = 0; c < 80; c++) s += d.grid[r][c].ch; rows.push(s); }
        var e = window.__NH.engine;
        return {
            engine_mode: e && e.mode, frames: d.frames, final_screen: rows,
            queued: d.terminal.inputQueueLength,
            engine_ms_per_move: (e && e.engineTime) ? +(e.engineTime.ms / e.engineTime.steps).toFixed(3) : null,
            gameover: !!(window.__NH.game && window.__NH.game.engine && window.__NH.game.engine.gameover),
            crossOriginIsolated: !!window.crossOriginIsolated,
        };
    })()`);

    const wall = times.reduce((a, b) => a + b, 0);
    const sorted = times.slice().sort((a, b) => a - b);
    return {
        shape_b: true,
        moves: times.length,
        wall_ms: wall,
        ms_per_move: +(wall / Math.max(1, times.length)).toFixed(3),
        median_ms: sorted[sorted.length >> 1] || 0,
        p95_ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
        max_ms: sorted[sorted.length - 1] || 0,
        first_frame_ms: first.ms,
        first_frame_mode: first.mode,
        auto_frame_ms: first.ms,
        keys_before_first_frame: first.keys_before,
        frames_before_first_key: first.frames,
        start_to_frame_ms: 0,
        ...tail,
        top_line: tail.final_screen[0].trimEnd(),
        status_line: tail.final_screen[22].trimEnd(),
        bottom_line: tail.final_screen[23].trimEnd(),
    };
}

let dev = null;
try {
    dev = await cdpConnect(DPORT);
    const sid = await dev.whenPage;
    await dev.call('Page.navigate', { url }, sid);
    if (shapeB) {
        const stream = keys || (() => {
            const n = Number(opt('moves', '240'));
            let s = '   ';
            for (let i = 0; s.length < n + 3; i++) s += 'lljjhhkk'[i % 8] + ' ' + 'hjkl'[(i * 5) % 4] + ' ' + 's ';
            return s;
        })();
        const r = await driveShapeB(dev, sid, stream);
        fs.writeFileSync(resultFile, JSON.stringify(r));
    }
} catch (e) {
    process.stderr.write(`\nFAIL: could not drive Chrome over CDP: ${e && e.message}\n`);
    chrome.kill(); server.kill('SIGINT');
    process.exit(1);
}

const deadline = Date.now() + timeoutMs;
while (!fs.existsSync(resultFile) && Date.now() < deadline) await sleep(200);
const timedOut = !fs.existsSync(resultFile);
// Give any last-gasp console entry (a rejected promise settling as the page
// finishes, a worker tearing down) a chance to arrive before we stop listening.
await sleep(300);
// The two harness pages narrate themselves on purpose ([bench] from
// index.html's ?bench= run, [repro] from viewer-repro.html). Those lines exist
// only in these runs and are not the page's own output, so they are not part of
// the tally that decides the verdict.
const cdpEntries = dev.entries.filter(e => !(e.kind === 'console.log'
    && (e.text.startsWith('[bench] ') || e.text.startsWith('[repro] '))));
dev.close();
chrome.kill();
await sleep(200);
server.kill('SIGINT');
await sleep(200);

const reqs = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
const blocked = reqs.filter(r => r.kind === 'BLOCKED');
const notFound = reqs.filter(r => r.status === 404 && r.kind !== 'BROWSER-UA');
process.stderr.write(`\n=== Request log ===\n  ${reqs.length} requests, ${blocked.length} out-of-scope, ${notFound.length} 404s\n`);
for (const r of [...blocked, ...notFound]) process.stderr.write(`    ${r.kind} ${r.status} ${r.path}\n`);

// The judge's browser check fails on console output, so make it visible here.
// Chrome's --enable-logging=stderr writes page console messages as
// "...:INFO:CONSOLE:<line>] "<text>", source: ..." (every severity lands on
// INFO, so match the tag, not the level). Chrome's own infrastructure chatter —
// DNS, extension loader, cookie store — is not the page's and is dropped; so is
// the page's own [bench] result line, which only exists in ?bench= runs.
const consoleLines = chromeErr.split('\n')
    .filter(l => /:CONSOLE[:(]/.test(l))
    .filter(l => !l.includes('"[bench] '));
fs.writeFileSync(path.join(work, 'chrome-stderr.log'), chromeErr);   // --keep to inspect
process.stderr.write(`\n=== Browser console (Chrome stderr) ===\n  ${consoleLines.length} error/warning/console line(s)\n`);
for (const l of consoleLines.slice(0, 20)) process.stderr.write('    ' + l.trim() + '\n');

// The list that actually decides the judge's playability verdict.
process.stderr.write(`\n=== Browser console (CDP: Log + Runtime, all targets) ===\n  ${cdpEntries.length} entr${cdpEntries.length === 1 ? 'y' : 'ies'}\n`);
for (const e of cdpEntries.slice(0, 30)) process.stderr.write(`    [${e.where}] ${e.kind}: ${e.text}\n`);

if (timedOut) {
    process.stderr.write('\nFAIL: the page never reported. Chrome stderr tail:\n' + chromeErr.slice(-4000) + '\n');
    process.exit(1);
}

const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));

if (multigame) {
    // What is being checked is that game 2 is hosted by something OTHER than
    // the spent page realm — a worker transport, a ReplayEngine realm, or a
    // refusal that says why — and never by the arena game 1 left behind.
    const gs = report.games || [];
    process.stderr.write('\n=== Two interactive games, one page, no reload ===\n');
    for (const g of gs) {
        process.stderr.write(`  game ${g.n}: ${g.error ? 'ERROR ' + g.error : `mode=${g.mode} moves=${g.moves} `
            + `start->frame=${g.start_to_frame_ms}ms status=${JSON.stringify(g.status)}`}\n`);
    }
    // Game 1 must play. Game 2 must either play in a realm of its own or say,
    // in words, that it could not get one — the one forbidden outcome is a
    // game 2 that "succeeds" in game 1's arena, which shows up as a second
    // main-thread mode or as NetHack's own "called more than once" garbage.
    const g1 = gs[0] || {};
    const g2 = gs[1] || {};
    const bad = [];
    if (g1.error || !g1.moves) bad.push('game 1 did not play: ' + (g1.error || 'no moves'));
    if (!g2.error && g2.mode === 'main') bad.push('game 2 was hosted by the spent page realm');
    if (!g2.error && !g2.moves) bad.push('game 2 neither played nor explained itself');
    if (g2.error && !/realm|transport|Worker|reload/i.test(g2.error)) {
        bad.push('game 2 failed without an explanation: ' + g2.error);
    }
    for (const b of bad) process.stderr.write(`  FAIL: ${b}\n`);
    process.stdout.write('__PLAYABILITY_BROWSER_JSON__\n');
    process.stdout.write(JSON.stringify({ ...report, multigame: true, transport: transport || null,
        console_entries: cdpEntries, out_of_scope: blocked.map(r => r.path) }, null, 2) + '\n');
    if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    process.exit((!report.error && !bad.length && !blocked.length && !cdpEntries.length) ? 0 : 1);
}

if (viewer) {
    // One import of js/jsmain.js, N sessions through it. What is being checked
    // is that session 2 does not land in session 1's spent C globals, and that
    // nothing says anything on the console while it happens.
    const sessions = report.sessions || [];
    const bad = sessions.filter(s => s.error);
    process.stderr.write('\n=== Session Viewer shape (one import, many sessions) ===\n');
    for (const s of sessions) {
        process.stderr.write(`  ${s.error ? 'FAIL' : 'ok  '} ${s.session}`
            + `  segments=${(s.segments || []).map(x => x.screens).join('+') || '-'}`
            + `${s.error ? '\n       ' + s.error.split('\n')[0] : ''}\n`);
    }
    process.stdout.write('__PLAYABILITY_BROWSER_JSON__\n');
    process.stdout.write(JSON.stringify({ ...report, viewer: true, judge_stub: judgeStub,
        console_entries: cdpEntries, out_of_scope: blocked.map(r => r.path) }, null, 2) + '\n');
    if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    process.exit((!report.error && !bad.length && !blocked.length && !cdpEntries.length) ? 0 : 1);
}

if (shapeB) {
    // The two claims, stated as assertions rather than as a number to squint at.
    const bad = [];
    if (report.error) bad.push(report.error);
    if (!report.first_frame_ms) bad.push('no game frame painted with nothing typed');
    if (report.keys_before_first_frame) {
        bad.push(`${report.keys_before_first_frame} key(s) were typed before the first frame`);
    }
    if (!report.moves) bad.push('the driver\'s keys were not consumed');
    if (report.queued) bad.push(`${report.queued} key(s) left unconsumed in the terminal queue`);
    process.stderr.write('\n=== Page-driving harness (frame first, then keys, all from outside) ===\n');
    process.stderr.write(`  frame with nothing typed : ${report.first_frame_ms || 'NONE'} ms`
        + `${report.first_frame_mode ? ` (painted by ${report.first_frame_mode})` : ''}\n`);
    process.stderr.write(`  keys before that frame   : ${report.keys_before_first_frame}\n`);
    process.stderr.write(`  keys consumed after it   : ${report.moves}\n`);
    process.stderr.write(`  ms/move                  : ${report.ms_per_move}  (incl. one CDP round trip each; `
        + `engine ${report.engine_ms_per_move})\n`);
    process.stderr.write(`  status line              : ${JSON.stringify(report.status_line)}\n`);
    process.stderr.write(`  turn counter             : ${JSON.stringify(report.bottom_line)}\n`);
    for (const b of bad) process.stderr.write(`  FAIL: ${b}\n`);
    process.stdout.write('__PLAYABILITY_BROWSER_JSON__\n');
    process.stdout.write(JSON.stringify({ ...report, transport: transport || null,
        console_entries: cdpEntries, out_of_scope: blocked.map(r => r.path) }, null, 2) + '\n');
    if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    process.exit((!bad.length && !blocked.length && !cdpEntries.length) ? 0 : 1);
}

process.stderr.write('\n=== Interactive play ===\n');
process.stderr.write(`  engine transport : ${report.engine_mode}  (crossOriginIsolated=${report.crossOriginIsolated}`
    + `${cpuThrottle > 1 ? `, cpu throttle ${cpuThrottle}x on every page target` : ''})\n`);
// The judge's browser check gives a session a few seconds to show something.
// This is that clock: navigation start to the first painted frame, whichever
// engine won the boot race in js/boot/interactive.mjs.
process.stderr.write(`  first frame      : ${report.first_frame_ms} ms  (painted by ${report.first_frame_mode}`
    + `${report.upgraded ? `, upgraded to ${report.engine_mode} mid-game` : ''})\n`);
// The clock the judge's harness actually starts: t_start, then start().
process.stderr.write(`  start -> frame   : ${report.start_to_frame_ms} ms`
    + `  (prewarmed=${report.prewarmed}, warmed=${report.prewarm_warmed}`
    + `${report.part2_ms ? `, part-1 window ${report.part2_ms} ms` : ''})\n`);
process.stderr.write(`  moves            : ${report.moves}\n`);
process.stderr.write(`  ms/move          : ${report.ms_per_move}  (median ${report.median_ms}, p95 ${report.p95_ms}, max ${report.max_ms})\n`);
process.stderr.write(`  frames painted   : ${report.frames}\n`);
process.stderr.write(`  top line         : ${JSON.stringify(report.top_line)}\n`);
process.stderr.write(`  status line      : ${JSON.stringify(report.status_line)}\n`);

process.stdout.write('__PLAYABILITY_BROWSER_JSON__\n');
process.stdout.write(JSON.stringify({
    ...report, coi, transport: transport || null, cpu_throttle: cpuThrottle || null,
    out_of_scope: blocked.map(r => r.path),
    console_entries: cdpEntries,
}, null, 2) + '\n');
if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
else process.stderr.write(`(artifacts kept in ${work})\n`);
process.exit(report.moves > 0 && !blocked.length ? 0 : 1);
