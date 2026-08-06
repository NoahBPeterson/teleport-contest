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
import fs from 'node:fs';
import path from 'node:path';
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
    if (SERVED_FILES.includes(pathname)) return 'IN-SCOPE';
    const seg = pathname.split('/').filter(Boolean)[0];
    return SERVED_ROOTS.includes(seg) ? 'IN-SCOPE' : 'BLOCKED';
}

function send(res, status, body, type, extra = {}) {
    res.writeHead(status, {
        'content-type': type,
        'content-length': Buffer.byteLength(body),
        // No caching: every reload must re-fetch, so the request log is a true
        // record of what the module graph pulled.
        'cache-control': 'no-store',
        ...COI_HEADERS,
        ...extra,
    });
    res.end(body);
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

const server = http.createServer(async (req, res) => {
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
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
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

    // IN-SCOPE: plain static file out of js/ or frozen/, no directory escapes.
    const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    const okRoot = SERVED_ROOTS.some(r => file.startsWith(path.join(ROOT, r) + path.sep))
        || SERVED_FILES.includes(pathname);
    if (!okRoot || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        finish(404);
        return send(res, 404, 'Not Found\n', 'text/plain');
    }
    finish(200);
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[judge-sim] http://127.0.0.1:${PORT}/  (serving ${SERVED_ROOTS.map(r => '/' + r + '/**').join(' ')} + /__sim/**)\n`);
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
