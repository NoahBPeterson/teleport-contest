#!/usr/bin/env node
// wire-probe.mjs — what the mirror charges, per request and per byte.
//
// docs/NOTES-startup.md §6.3 measured the first half of this from a page:
// 180 cache-busted copies of a 1.9 KB file cost 2.1–2.9 s, so the edge charges
// ~12–16 ms of serialized work per request whatever the request is. That number
// is what overturned §2.5 and paid for tools/c2js/bundle.mjs.
//
// The second half is the one §8 left open: **how many chunks**. Bundling to ONE
// file removes the per-request tax, but a single 2.3 MB response is also the
// one shape whose throughput depends on a single stream ramping up. If four
// streams move four times the bytes of one, chunking is worth the machinery; if
// one stream already saturates the link, it is not. That question cannot be
// answered by tools/judge-sim/server.mjs, whose `--bw`/`--bw-lanes` model *is*
// the answer it would give. It has to be asked of the mirror.
//
// So: one HTTP/2 session to the origin — which is exactly what Chrome opens —
// and K concurrent streams over it, timed. `node:http2` rather than `fetch`
// deliberately: undici speaks HTTP/1.1, and an h1 client would price
// concurrency at Chrome's six-connection cap instead of h2's stream
// multiplexing, which is the mistake §6.4 records the stand-in making.
//
// USAGE
//   node tools/judge-sim/wire-probe.mjs                        # the default suite
//   node tools/judge-sim/wire-probe.mjs --origin=https://…  --base=/play/x/
//   node tools/judge-sim/wire-probe.mjs --rounds=3
//
// Every fetch is cache-busted with a distinct query string, so nothing here can
// be answered out of a cache — the numbers are the edge's, every time. The
// first round of anything on this mirror is a CDN miss and is reported
// separately rather than averaged in.

import http2 from 'node:http2';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=').slice(1).join('=');

const ORIGIN = opt('origin', 'https://mazesofmenace.ai');
const BASE = opt('base', '/play/NoahBPeterson/');
const ROUNDS = Number(opt('rounds', '3'));

let session = null;

// FLOW CONTROL IS NOT OPTIONAL HERE, and getting it wrong invents a number.
// node:http2 defaults to a 64 KB receive window per stream and 64 KB for the
// connection, so a client that does not raise it stalls every stream after 64 KB
// and reports the *window*, not the link: with the defaults this probe measured
// the published tree at 0.33 MB/s against the 2.7 MB/s the same tree fetches at
// from Chrome in the same minute. Chrome opens with a multi-megabyte window;
// match it, or measure node.
const WINDOW = 16 * 1024 * 1024;
function connect() {
    return new Promise((resolve, reject) => {
        const s = http2.connect(ORIGIN, {
            settings: { enablePush: false, initialWindowSize: WINDOW },
        });
        s.once('connect', () => {
            try { s.setLocalWindowSize(WINDOW); } catch { /* older node: stream window is enough */ }
            resolve(s);
        });
        s.once('error', reject);
    });
}

/** One GET over the shared session; resolves with the body's byte count. */
function get(pathname) {
    return new Promise((resolve, reject) => {
        const req = session.request({
            ':path': pathname,
            'accept-encoding': 'gzip, deflate, br',
            'user-agent': 'c2js-wire-probe',
        });
        let n = 0;
        let status = 0;
        req.on('response', (h) => { status = h[':status']; });
        req.on('data', (c) => { n += c.length; });
        req.on('end', () => resolve({ bytes: n, status }));
        req.on('error', reject);
        req.end();
    });
}

/** K requests, all in flight at once. Returns {ms, bytes, requests}. */
async function burst(paths) {
    const t0 = performance.now();
    const rs = await Promise.all(paths.map(get));
    const ms = performance.now() - t0;
    // A 404 is still a request the edge served and still a request a boot would
    // have paid for, so it is counted rather than thrown on — the mirror's crawl
    // lags this branch and a handful of paths here are newer than it is. It is
    // reported, because a suite that quietly measured 404s would be measuring
    // nothing.
    const missing = rs.filter((r) => r.status !== 200).length;
    return { ms, bytes: rs.reduce((a, r) => a + r.bytes, 0), requests: paths.length, missing };
}

let bustSeq = 0;
const bust = (p) => `${BASE}${p}${p.includes('?') ? '&' : '?'}wp=${Date.now()}_${bustSeq++}`;

function row(label, r) {
    const mbps = (r.bytes / 1024 / 1024) / (r.ms / 1000);
    console.log(`  ${label.padEnd(38)} ${String(r.requests).padStart(4)} req  `
        + `${(r.bytes / 1024).toFixed(0).padStart(6)} KB  ${r.ms.toFixed(0).padStart(6)} ms  `
        + `${mbps.toFixed(2).padStart(6)} MB/s${r.missing ? `  (${r.missing} not published yet)` : ''}`);
    return { ...r, mbps };
}

// The tree as the mirror publishes it, in the order the reset barrel names it —
// i.e. what a boot actually asks for.
function treePaths(dir) {
    const abs = path.join(repoRoot, dir);
    return fs.readdirSync(abs).filter((f) => f.endsWith('.js') && f !== '__bundle.js')
        .map((f) => `${dir}/${f}`);
}

// A file big enough that a stream has room to ramp; the largest the mirror
// publishes is js/generated-y/monst.js at ~90 KB on the wire.
// Override with --big=<path>. The default is the largest .js the mirror
// publishes (~90 KB on the wire); js/data-nethackdir/chunk-01.mjs is bigger
// (~225 KB) and gives a single stream more runway to ramp, which is the one
// thing a small file cannot measure.
const BIG = opt('big', 'js/generated-y/monst.js');
// A file the mirror has published for a while and that is genuinely tiny; §6.3
// used one of this size. (Not js/boot/preload.mjs — the mirror's crawl predates
// it, and a 404 is not a measurement.)
const SMALL = 'js/generated-y/track.js';

// ---------------------------------------------------------------------------
// --via=chrome — the same bursts, but from a page
// ---------------------------------------------------------------------------
//
// WHY BOTH. §6.3's 12–16 ms per request was measured from a page, with
// `fetch()`, in a renderer. This file's default measures the same origin with
// `node:http2` and no renderer at all. When the two disagree, the difference is
// not the edge — it is what a browser adds on top of it, and that is worth
// knowing before ~2 s is attributed to a CDN. Run both; quote both.
async function viaChrome(plan) {
    const { spawn } = await import('node:child_process');
    const os = await import('node:os');
    const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const dport = 9711;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-probe-'));
    const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
        '--no-default-browser-check', `--user-data-dir=${profile}`,
        `--remote-debugging-port=${dport}`, 'about:blank'], { stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let info = null;
    for (let i = 0; i < 100 && !info; i++) {
        await sleep(50);
        try { info = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json(); } catch { /* not yet */ }
    }
    const target = info.find((t) => t.type === 'page');
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => { sock.onopen = r; });
    let id = 0;
    const pending = new Map();
    sock.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        sock.send(JSON.stringify({ id: n, method, params }));
    });
    await send('Page.navigate', { url: ORIGIN + BASE });
    await sleep(4000);
    const out = [];
    for (const { label, paths } of plan) {
        const expr = `(async () => { const t = performance.now();
            await Promise.all(${JSON.stringify(paths)}.map((u) => fetch(u).then((r) => r.arrayBuffer().then((b) => [r.status, b.byteLength]))));
            return performance.now() - t; })()`;
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        out.push({ label, requests: paths.length, ms: r.result?.result?.value ?? -1 });
    }
    sock.close();
    chrome.kill();
    return out;
}

if (args.includes('--via=chrome')) {
    const plan = [];
    for (const k of [1, 40, 180]) for (let r = 0; r < ROUNDS; r++) {
        plan.push({ label: `${k} x ${'js/generated-y/track.js'}`, paths: Array.from({ length: k }, () => bust('js/generated-y/track.js')) });
    }
    for (const k of [1, 4, 8, 16]) for (let r = 0; r < ROUNDS; r++) {
        plan.push({ label: `${k} x js/generated-y/monst.js`, paths: Array.from({ length: k }, () => bust('js/generated-y/monst.js')) });
    }
    for (let r = 0; r < ROUNDS; r++) {
        plan.push({ label: `${treePaths('js/generated-y').length} x js/generated-y/*.js`, paths: treePaths('js/generated-y').map(bust) });
    }
    console.log(`wire-probe --via=chrome: ${ORIGIN}${BASE}  (a real renderer, fetch(), cache-busted)\n`);
    for (const r of await viaChrome(plan)) {
        console.log(`  ${r.label.padEnd(38)} ${String(r.requests).padStart(4)} req  ${r.ms.toFixed(0).padStart(6)} ms`);
    }
    process.exit(0);
}

session = await connect();
console.log(`wire-probe: ${ORIGIN}${BASE}  (HTTP/2, one session, cache-busted)\n`);

// ---- per-request cost, re-measured, because link quality varies by the hour --
console.log('per-request cost (a tiny file, K copies, K streams):');
const oneReq = [];
for (const k of [1, 40, 180]) {
    for (let r = 0; r < ROUNDS; r++) {
        const got = row(`${k} x ${SMALL}${r === 0 ? '  (cold)' : ''}`,
            await burst(Array.from({ length: k }, () => bust(SMALL))));
        if (k === 1 && r > 0) oneReq.push(got.ms);
    }
}
if (!oneReq.length) oneReq.push(0);

// ---- the granularity question -----------------------------------------------
//
// A FIXED PAYLOAD, split K ways. The mirror publishes no file the size of the
// bundle, so the payload is built from K cache-busted copies of the biggest one
// it does publish and the comparison is made at equal K*size — which is the
// right control anyway: it isolates stream count from byte count.
console.log('\nthe granularity question — same bytes, K streams:');
const gran = {};
for (const k of [1, 2, 4, 8, 16]) {
    const runs = [];
    for (let r = 0; r < ROUNDS; r++) {
        runs.push(row(`${String(k).padStart(2)} x monst.js`,
            await burst(Array.from({ length: k }, () => bust(BIG)))));
    }
    gran[k] = runs;
}

// ---- what a boot pays today, and what it would pay bundled ------------------
console.log('\nthe tree as published, whole:');
const tree = treePaths('js/generated-y');
const treeRuns = [];
for (let r = 0; r < ROUNDS; r++) {
    treeRuns.push(row(`${tree.length} x js/generated-y/*.js`, await burst(tree.map(bust))));
}

// A raw MB/s per burst is the wrong summary and would answer the question
// backwards: every burst pays ONE round trip whatever its size, so a bigger
// payload looks faster simply by amortising it. Subtract the round trip — which
// the 1-request row measures directly — and what is left is the link's rate.
// THAT is the number that decides chunking.
const rtt = Math.min(...oneReq);
console.log(`\nsummary — one round trip is ${rtt.toFixed(0)} ms; transfer rate with it removed:`);
for (const k of Object.keys(gran)) {
    const warm = gran[k].slice(1);
    const rates = warm.map((x) => (x.bytes / 1024 / 1024) / Math.max(1, x.ms - rtt) * 1000)
        .sort((a, b) => a - b);
    console.log(`  ${String(k).padStart(3)} stream(s)  ${rates[Math.floor(rates.length / 2)].toFixed(2)} MB/s`);
}
if (treeRuns.length) {
    const rates = treeRuns.map((x) => (x.bytes / 1024 / 1024) / (x.ms - rtt) * 1000).sort((a, b) => a - b);
    console.log(`  ${String(treeRuns[0].requests).padStart(3)} stream(s)  `
        + `${rates[Math.floor(rates.length / 2)].toFixed(2)} MB/s   (the tree)`);
}

// The bundle's own wire size, for the arithmetic the notes quote.
const bundlePath = path.join(repoRoot, 'js/generated-y/__bundle.js');
if (fs.existsSync(bundlePath)) {
    const gz = zlib.gzipSync(fs.readFileSync(bundlePath), { level: 9 }).length;
    console.log(`\njs/generated-y/__bundle.js: ${(gz / 1024).toFixed(0)} KB gzipped, 1 request`);
}

session.close();
