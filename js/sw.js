// sw.js — a keyboard, delivered synchronously.
//
// The engine thread (js/boot/engine-worker.mjs) has to *block* inside the
// transpiled getchar().  On a crossOriginIsolated page that is Atomics.wait on
// a SharedArrayBuffer; on GitHub Pages — which serves
// mazesofmenace.ai/play/<owner>/ and sends no COOP/COEP, so SharedArrayBuffer
// does not exist — the only synchronous blocking primitive left in a worker is
// a synchronous XMLHttpRequest.  This service worker is what makes that XHR
// block for a useful reason: it intercepts the request and does not answer it
// until the page hands us the next keystroke.
//
//   engine worker            service worker              page
//   ------------------------------------------------------------------
//   sync XHR /js/__nhkey ->  fetch event, park it
//                            (waiter queued)
//                                                 <-  postMessage {nhkey, code}
//                        <-  respond "<code>"
//   getchar() returns code
//
// Scope: registered from /js/sw.js, so the scope is /js/ — the engine worker
// script and the parked endpoint both live under it, which is all we need.
// (Root scope would require a Service-Worker-Allowed header that static
// hosting will not send.)
//
// A parked fetch keeps the service worker alive, but not forever: we answer
// with RETRY after 20 s so the browser never kills us mid-park, and the engine
// simply asks again.

const KEY_PATH = '/js/__nhkey';
const RETRY = '-2';
const PROBE_OK = 'nhkey-ok';

const waiters = [];   // pending resolve() callbacks, oldest first
const keys = [];      // keys that arrived while nobody was waiting

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'nhkey') return;
    const w = waiters.shift();
    if (w) w(String(m.code));
    else keys.push(String(m.code));
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (!url.pathname.endsWith(KEY_PATH)) return;   // everything else: network

    e.respondWith(new Promise((resolve) => {
        const answer = (body) => resolve(new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        }));
        // Liveness probe: the engine worker asks once, before it starts the
        // game, whether this service worker is really intercepting its
        // requests. If it isn't (an uncontrolled client), the request reaches
        // the network instead and comes back 404, and the driver can degrade
        // instead of hanging on the first keystroke forever.
        if (url.searchParams.get('probe') === '1') return answer(PROBE_OK);
        // Hand over everything queued, not just the next key. A round-trip
        // through here costs ~4 ms of Chrome's service-worker dispatch, which
        // is most of the per-keystroke budget on a host that cannot give us
        // SharedArrayBuffer; a player holding a movement key (or a harness
        // injecting keys faster than the game consumes them) pays it once for
        // the whole burst instead of once per key.
        if (keys.length) { const batch = keys.splice(0, keys.length); return answer(batch.join(',')); }
        const timer = setTimeout(() => {
            const i = waiters.indexOf(deliver);
            if (i >= 0) waiters.splice(i, 1);
            answer(RETRY);
        }, 20000);
        const deliver = (body) => { clearTimeout(timer); answer(body); };
        waiters.push(deliver);
    }));
});
