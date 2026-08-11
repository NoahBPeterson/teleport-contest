// server.mjs — a local stand-in for the contest mirror (mazesofmenace.ai/play/<user>/).
//
// The mirror serves ONLY js/** and frozen/** out of the fork tree. Everything
// else — sessions/, docs/, tools/, the old top-level data/ — is a 404 there. A
// module graph that reaches outside those two directories loads fine on a
// developer's disk and dies in the browser with
//   "error loading dynamically imported module: .../data/nethackdir/index.mjs"
// which is exactly how a 0/0 judge round happens.
//
// So this server enforces the mirror's shape and *logs every request*:
//
//   IN-SCOPE  /js/**, /frozen/**       — the only paths the real mirror answers
//   HARNESS   /__sim/**               — the judge's own driver page + session
//                                        JSON; on the real judge this comes
//                                        from their side of the fence, never
//                                        from our tree, so it is accounted
//                                        separately and must never be reached
//                                        from a module import
//   BLOCKED   anything else            — 404, same as the mirror
//
// Usage: node tools/judge-sim/server.mjs [--port 8917] [--log requests.jsonl]

import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
function flag(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = Number(flag('--port', '8917'));
const LOG = flag('--log', '');
const RESULT_FILE = flag('--result', '');

// Exactly what the mirror publishes: two directories, plus the play page and
// its snapshot at the root. (Verified against the live mirror:
//   /play/<owner>/index.html      200
//   /play/<owner>/snapshot.json   200
//   /play/<owner>/js/**           200
//   /play/<owner>/frozen/**       200
//   /play/<owner>/README.md       404 )
const SERVED_ROOTS = ['js', 'frozen'];
const SERVED_FILES = ['/', '/index.html', '/snapshot.json'];

// --coi sends COOP/COEP, which is what makes crossOriginIsolated (and hence
// SharedArrayBuffer) available. GitHub Pages does NOT send them, so the
// default here matches the real mirror and exercises the service-worker
// input path instead.
const COI = args.includes('--coi');

// --no-sw: 404 the service worker script, so the page cannot get the
// service-worker input transport and (without COI) falls back to
// js/boot/interactive.mjs's ReplayEngine. Test-only switch — the real mirror
// always serves js/sw.js — and the only way to measure the fallback path
// without touching the transport selection itself.
const NO_SW = args.includes('--no-sw');

// --inert-sw: serve a service worker that registers and activates normally but
// intercepts nothing. This is the failure the transport ladder in
// js/boot/interactive.mjs exists for, and the one a 404 does *not* reproduce:
// navigator.serviceWorker.register() resolves, reg.active is set, everything the
// page can see says the transport is there — and the engine's synchronous XHR
// goes straight to the network, where nobody is waiting to answer it. Whether a
// worker is a controlled client is a per-engine detail we cannot make Chrome
// get wrong on demand, so we make the service worker sit it out instead; the
// realm sees exactly what an uncontrolled client sees.
const INERT_SW = args.includes('--inert-sw');
const INERT_SW_JS = `// judge-sim --inert-sw: registers, activates, intercepts nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
`;

// --hang-sw: serve a service worker that registers, activates, intercepts — and
// never answers. Every probe and every key request is parked forever.
//
// This is the failure the transport ladder could not survive and the race
// exists for. --inert-sw fails *fast* (the request goes to the network and
// comes back), so it never cost the old ladder anything but a few milliseconds;
// a service worker that is there but not answering costs a full PROBE_TIMEOUT
// per transport, one after the other, before the page can even start booting
// the fallback. That is what "0 moves, no error, no console output" looks like
// from the judge's side, and it is the only way to reproduce it here.
const HANG_SW = args.includes('--hang-sw');
const HANG_SW_JS = `// judge-sim --hang-sw: registers, activates, answers nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // Only the two URLs the engine blocks on; everything else (module scripts!)
    // has to go to the network as usual.
    if (url.searchParams.has('__nhprobe') || url.pathname.endsWith('/js/__nhkey')) {
        e.respondWith(new Promise(() => { /* never */ }));
    }
});
`;

// --sw-deny-dedicated: serve the real js/sw.js with its probe answer made
// conditional on the client type — a dedicated worker is told "not
// intercepted", a SharedWorker is told the truth.
//
// This is the browser difference the ladder was built for, staged. Chromium
// controls dedicated workers by their own script URL and there is no flag that
// makes it stop, so the service worker declines instead; the engine worker's
// realm sees precisely what an uncontrolled client sees — its request going to
// the network and coming back with sw.js's own bytes. With rung 2 failing that
// way, rung 3 has to be what picks the game up.
const DENY_DEDICATED = args.includes('--sw-deny-dedicated');

// --their-page: serve THE JUDGE'S OWN PLAY PAGE at the fork root, verbatim.
//
// Provenance: tools/judge-sim/fixtures-judge-play-page.html was fetched from
// https://mazesofmenace.ai/play/NoahBPeterson/ on 2026-08-09, and
// tools/judge-sim/fixtures-judge-shim-node-builtins.mjs from
// https://mazesofmenace.ai/shim/node-builtins.mjs the same day. Neither file is
// ours and neither is edited here — that is the point. The mirror never serves
// our index.html to a player or to the judge's browser check: it serves that
// page, and that page drives our modules through an API contract we had only
// ever inferred. Every other mode in this directory drives *our* page, so not
// one of them could see a gap between the two.
//
// Two extra routes come with it, both on the judge's side of the fence and
// accounted as JUDGE rather than IN-SCOPE:
//
//   /shim/node-builtins.mjs   the import map's target. Vendored above.
//   /css2 + /s/**            Google Fonts. The page <link>s them and headless
//                            Chrome has no route to fonts.googleapis.com, so a
//                            run would collect two network console entries that
//                            the real mirror does not produce. playability.mjs
//                            points those hostnames here with
//                            --host-resolver-rules and this answers them, so
//                            the console tally stays a measurement of *our*
//                            code.
const THEIR_PAGE = args.includes('--their-page');
const THEIR_PAGE_FILE = path.join(HERE, 'fixtures-judge-play-page.html');
const THEIR_SHIM_FILE = path.join(HERE, 'fixtures-judge-shim-node-builtins.mjs');
const PROBE_LINE = '    if (url.searchParams.has(PROBE_PARAM)) return e.respondWith(plain(PROBE_ALIVE));';
const PROBE_LINE_DENIED = `    if (url.searchParams.has(PROBE_PARAM)) return e.respondWith(
        self.clients.get(e.clientId).then((c) => (c && c.type === 'worker')
            ? fetch(e.request)              // judge-sim: as if this client were uncontrolled
            : plain(PROBE_ALIVE)));`;

function denyDedicatedSw() {
    const src = fs.readFileSync(path.join(ROOT, 'js/sw.js'), 'utf8');
    if (!src.includes(PROBE_LINE)) {
        // Loud on purpose: a silently-unpatched service worker would make this
        // switch test the opposite of what it claims to.
        throw new Error('--sw-deny-dedicated: js/sw.js no longer contains the probe line to patch');
    }
    return src.replace(PROBE_LINE, PROBE_LINE_DENIED);
}
// --judge-stub: serve the play page (and the viewer repro) inside a host page
// shaped like the judge's own.
//
// Their pages are not blank: they install a `process` stub whose
// versions.node is set, and an import map that resolves `node:*` to shims of
// their own. Confirmed in the Session Viewer, and every indication says the
// playability harness does the same. Our code used to read that stub, conclude
// it was running in Node, and take Node-only paths in a browser — a game
// replayed into a spent realm (js/jsmain.js), an engine hosted on
// `node:worker_threads` that cannot exist there (js/boot/interactive.mjs).
// Neither says anything on the console; both simply fail to produce a frame.
//
// So the environment checks now ask what the realm *is*, and this switch is how
// that is tested: same stub, same import map, injected ahead of everything.
const JUDGE_STUB = args.includes('--judge-stub');
const JUDGE_STUB_HEAD = `
<script type="importmap">{"imports":{
  "node:worker_threads":"data:text/javascript,export const Worker=undefined;export const parentPort=null;",
  "node:module":"data:text/javascript,export function enableCompileCache(){return{status:0}};",
  "node:url":"data:text/javascript,export function fileURLToPath(u){return String(u)};"
}}</script>
<script>
// judge-sim --judge-stub: the host page's Node stand-in, installed before any
// module of ours loads. stderr goes to the console on purpose — anything we
// write there in this environment is a console line the judge would count.
globalThis.process = {
    versions: { node: '0.0.0' }, env: {}, argv: ['nethack'], platform: 'linux',
    stdout: { write: () => true },
    stderr: { write: (s) => { console.error(s); return true; } },
    exit() {},
};
</script>
`;

/** Put the stub host page around a document we serve. */
function withJudgeStub(html) {
    const s = html.toString('utf8');
    const at = s.indexOf('<head>');
    if (at >= 0) return s.slice(0, at + 6) + JUDGE_STUB_HEAD + s.slice(at + 6);
    // viewer-repro.html has no <head> of its own.
    return JUDGE_STUB_HEAD + s;
}

const COI_HEADERS = COI ? {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
} : {};

const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
};

const requests = [];
let logStream = null;
if (LOG) logStream = fs.createWriteStream(path.resolve(ROOT, LOG), { flags: 'w' });

function record(entry) {
    requests.push(entry);
    if (logStream) logStream.write(JSON.stringify(entry) + '\n');
}

function classify(pathname) {
    // Chrome asks for this on its own for any top-level document; it is not part
    // of anyone's module graph. It is answered rather than 404'd — see the
    // handler — because a 404 puts a line in the browser console, and the whole
    // point of the console tally is that a zero there means zero.
    if (pathname === '/favicon.ico') return 'BROWSER-UA';
    if (pathname.startsWith('/__sim/')) return 'HARNESS';
    // The judge's own assets (--their-page). Served by the mirror, not by the
    // fork, so they are neither IN-SCOPE nor a violation when they are fetched.
    if (THEIR_PAGE && (pathname.startsWith('/shim/')
                       || pathname === '/css2' || pathname.startsWith('/s/'))) return 'JUDGE';
    if (SERVED_FILES.includes(pathname)) return 'IN-SCOPE';
    const seg = pathname.split('/').filter(Boolean)[0];
    return SERVED_ROOTS.includes(seg) ? 'IN-SCOPE' : 'BLOCKED';
}

// --gzip: answer compressible bodies with `content-encoding: gzip`, the way the
// real mirror does. Off by default so the existing gates see byte-for-byte the
// responses they always saw; on for the network measurements, where it is the
// difference between pricing the generated tree at 16 MB and pricing it at the
// ~2.7 MB the mirror actually puts on the wire. The cache is per-path because
// one run fetches the same 180 modules from several realms.
const GZIP = args.includes('--gzip');
const gzCache = new Map();
function gzipFor(key, body) {
    let hit = gzCache.get(key);
    if (!hit) { hit = zlib.gzipSync(body, { level: 6 }); gzCache.set(key, hit); }
    return hit;
}

function send(res, status, body, type, extra = {}, gzKey = null) {
    let payload = body;
    const enc = {};
    if (GZIP && gzKey && /text|json|javascript/.test(type) && Buffer.byteLength(body) > 512) {
        payload = gzipFor(gzKey, body);
        enc['content-encoding'] = 'gzip';
        enc.vary = 'accept-encoding';
    }
    const head = () => res.writeHead(status, {
        'content-type': type,
        'content-length': Buffer.byteLength(payload),
        // No caching: every reload must re-fetch, so the request log is a true
        // record of what the module graph pulled.
        'cache-control': 'no-store',
        ...COI_HEADERS,
        ...enc,
        ...extra,
    });
    const wait = wireDelayFor(Buffer.byteLength(payload));
    if (!wait) { head(); return res.end(payload); }
    head();
    setTimeout(() => res.end(payload), wait);
}

// /__sim/session/<name> — normalized session segments, computed here with the
// judge's own frozen/session_loader.mjs so the browser sees byte-identical
// replay input to what Node's ps_test_runner builds.
async function serveSession(name) {
    const { normalizeSession } = await import(new URL('../../frozen/session_loader.mjs', import.meta.url).href);
    for (const dir of ['sessions', 'sessions-extra', 'sessions-landmine']) {
        const p = path.join(ROOT, dir, name);
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            const segments = normalizeSession(raw).segments.map(s => ({
                seed: s.seed, datetime: s.datetime, nethackrc: s.nethackrc, moves: s.moves,
            }));
            return JSON.stringify({ name, segments });
        }
    }
    return null;
}

// --latency=<ms> delays every response by that much, which is the one thing
// loopback cannot stage on its own: on the real mirror each of the ~170
// generated modules costs a round trip that this server answers in microseconds.
// A rung whose module graph is fetched *before* the clock starts wins exactly
// that latency, and without this switch the harness prices that win at zero.
const LATENCY_MS = Number((args.find(a => a.startsWith('--latency=')) || '').split('=')[1] || 0) || 0;

// --bw=<bytes/sec> is the other half of what loopback cannot stage. Latency is
// paid concurrently — every realm's requests wait out their round trip at the
// same time — but bandwidth is *shared*: 5 MB of engine tree takes 5 MB / link
// however many sockets it is spread over, and a change that only moves bytes
// around cannot be judged on a link with no ceiling. Modelled as `--bw-lanes`
// (default 8) equal wires: a response takes the earliest-free lane, reserves
// lanes*bytes/BW of it, and is released when its slot ends. The aggregate is
// exactly the link rate — a run that fetches half as much finishes in half the
// time — while one 3 MB response still cannot park 179 small ones behind it,
// which a single FIFO wire would and a real multiplexed connection does not.
// Off by default; every existing gate sees the unmetered server it always saw.
const BW = Number((args.find(a => a.startsWith('--bw=')) || '').split('=')[1] || 0) || 0;
const BW_LANES = Number((args.find(a => a.startsWith('--bw-lanes=')) || '').split('=')[1] || 0) || 8;
const laneFreeAt = new Array(BW_LANES).fill(0);
function wireDelayFor(bytes) {
    if (!BW) return 0;
    const now = Date.now();
    let k = 0;
    for (let i = 1; i < BW_LANES; i++) if (laneFreeAt[i] < laneFreeAt[k]) k = i;
    const start = Math.max(now, laneFreeAt[k]);
    const dur = (bytes / (BW / BW_LANES)) * 1000;
    laneFreeAt[k] = start + dur;
    return (start - now) + dur;
}

// --h2: speak HTTP/2 over TLS, which is what the mirror speaks and what
// loopback HTTP/1.1 cannot imitate. The difference is not cosmetic: Chrome caps
// an HTTP/1.1 origin at six concurrent connections, so a 425-request boot pays
// 425/6 serialized round trips there and none of them on h2. Measuring request
// *count* against an h1 server prices it at roughly seventy times what the
// mirror charges, which is how a loopback profile talks itself into the wrong
// answer. Off by default — the existing gates drive plain http — and the
// self-signed certificate lives in .cache/, so Chrome needs
// --ignore-certificate-errors to drive it.
const H2 = args.includes('--h2');
function h2Credentials() {
    const dir = path.join(ROOT, '.cache', 'judge-sim');
    const key = path.join(dir, 'localhost-key.pem');
    const crt = path.join(dir, 'localhost-cert.pem');
    if (!fs.existsSync(key) || !fs.existsSync(crt)) {
        fs.mkdirSync(dir, { recursive: true });
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', key, '-out', crt, '-days', '365',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
            { stdio: 'ignore' });
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), allowHTTP1: true };
}

const handler = async (req, res) => {
    if (LATENCY_MS) await new Promise((r) => setTimeout(r, LATENCY_MS));
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const kind = classify(pathname);

    const finish = (status) => record({ t: Date.now(), method: req.method, path: pathname, kind, status });

    // The origin that hosts the mirror has a favicon; only this stand-in, which
    // serves the fork at the origin root, would 404 it. A 404 here is a console
    // line that the real judge run does not have, so answer it empty.
    if (kind === 'BROWSER-UA') {
        finish(204);
        res.writeHead(204, COI_HEADERS);
        return res.end();
    }

    if (kind === 'BLOCKED') {
        finish(404);
        return send(res, 404, 'Not Found (mirror serves js/** and frozen/** only)\n', 'text/plain');
    }

    if (kind === 'JUDGE') {
        if (pathname === '/shim/node-builtins.mjs') {
            finish(200);
            return send(res, 200, fs.readFileSync(THEIR_SHIM_FILE), MIME['.mjs']);
        }
        // Google Fonts, pointed here by --host-resolver-rules. An empty
        // stylesheet declares no @font-face, so no font file is ever requested
        // and the page falls back to Georgia — which changes nothing about the
        // terminal, whose font stack is monospace and set inline.
        finish(200);
        return send(res, 200, '/* judge-sim: fonts stubbed */\n', MIME['.css']);
    }

    if (kind === 'HARNESS') {
        // The page posts its finished result back here: headless Chrome's
        // console/DOM capture is timing-dependent, an HTTP POST is not.
        if (pathname === '/__sim/result' && req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = Buffer.concat(chunks).toString('utf8');
            if (RESULT_FILE) fs.writeFileSync(path.resolve(ROOT, RESULT_FILE), body);
            process.stderr.write('[judge-sim] result received (' + body.length + ' bytes)\n');
            finish(200);
            return send(res, 200, 'ok\n', 'text/plain');
        }
        if (pathname.startsWith('/__sim/session/')) {
            const body = await serveSession(pathname.slice('/__sim/session/'.length));
            if (!body) { finish(404); return send(res, 404, 'no such session\n', 'text/plain'); }
            finish(200);
            return send(res, 200, body, MIME['.json']);
        }
        const rel = pathname.slice('/__sim/'.length) || 'driver.html';
        const file = path.join(HERE, rel);
        if (!file.startsWith(HERE) || !fs.existsSync(file)) {
            finish(404);
            return send(res, 404, 'no such harness file\n', 'text/plain');
        }
        finish(200);
        const harnessBody = fs.readFileSync(file);
        return send(res, 200, (JUDGE_STUB && file.endsWith('.html')) ? withJudgeStub(harnessBody) : harnessBody,
            MIME[path.extname(file)] || 'application/octet-stream');
    }

    if (pathname === '/js/sw.js') {
        if (NO_SW) {
            finish(404);
            return send(res, 404, 'Not Found (--no-sw)\n', 'text/plain');
        }
        if (INERT_SW) {
            finish(200);
            return send(res, 200, INERT_SW_JS, MIME['.js']);
        }
        if (HANG_SW) {
            finish(200);
            return send(res, 200, HANG_SW_JS, MIME['.js']);
        }
        if (DENY_DEDICATED) {
            finish(200);
            return send(res, 200, denyDedicatedSw(), MIME['.js']);
        }
    }

    // snapshot.json is written by the mirror's publisher, not by the fork, so it
    // is not in this tree. index.html reads it for the owner name; 404ing it
    // works but costs a console line the real run does not have.
    if (pathname === '/snapshot.json' && !fs.existsSync(path.join(ROOT, 'snapshot.json'))) {
        finish(200);
        return send(res, 200, JSON.stringify({ owner: 'judge-sim', fork: 'judge-sim/nethack' }), MIME['.json']);
    }

    // --their-page: the fork root is the judge's page, byte-for-byte as the
    // mirror serves it. Never rewritten — not even by --judge-stub, whose
    // whole payload (a Node-claiming `process`, an import map at the node:*
    // names) this page already carries for real.
    if (THEIR_PAGE && (pathname === '/' || pathname === '/index.html')) {
        finish(200);
        return send(res, 200, fs.readFileSync(THEIR_PAGE_FILE), MIME['.html']);
    }

    // IN-SCOPE: plain static file out of js/ or frozen/, no directory escapes.
    const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    const okRoot = SERVED_ROOTS.some(r => file.startsWith(path.join(ROOT, r) + path.sep))
        || SERVED_FILES.includes(pathname);
    if (!okRoot || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        finish(404);
        return send(res, 404, 'Not Found\n', 'text/plain');
    }
    finish(200);
    const body = fs.readFileSync(file);
    return send(res, 200, (JUDGE_STUB && file.endsWith('.html')) ? withJudgeStub(body) : body,
        MIME[path.extname(file)] || 'application/octet-stream', {},
        JUDGE_STUB && file.endsWith('.html') ? null : file);
};

const server = H2 ? http2.createSecureServer(h2Credentials(), handler) : http.createServer(handler);

server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[judge-sim] http${H2 ? 's' : ''}://127.0.0.1:${PORT}/  (serving ${SERVED_ROOTS.map(r => '/' + r + '/**').join(' ')} + /__sim/**)\n`);
});

// Print a request summary on shutdown so a one-shot run leaves evidence behind.
function summarize() {
    const by = {};
    for (const r of requests) by[r.kind] = (by[r.kind] || 0) + 1;
    const blocked = requests.filter(r => r.kind === 'BLOCKED');
    process.stderr.write(`[judge-sim] requests: ${requests.length} total ${JSON.stringify(by)}\n`);
    if (blocked.length) {
        process.stderr.write('[judge-sim] OUT-OF-SCOPE requests (would 404 on the mirror):\n');
        for (const r of blocked) process.stderr.write(`    ${r.path}\n`);
    }
}
process.on('SIGINT', () => { summarize(); process.exit(0); });
process.on('SIGTERM', () => { summarize(); process.exit(0); });
