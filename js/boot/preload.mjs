// preload.mjs — start fetching the engine before anybody asks for it.
//
// THE MEASUREMENT THIS EXISTS FOR. Driving the real mirror
// (https://mazesofmenace.ai/play/<owner>/) with headless Chrome, the judge's
// play page paints "press any key" at ~1.5 s and the first game frame at
// ~5.2 s. Of the 3.7 s between them, **the engine's own module tree does not
// start downloading until 1.5–3.2 s in**: the page waits out a service-worker
// registration, two worker realms spawning, a synchronous interception probe
// in each, and the fallback's head start — four to six round trips at ~320 ms
// apiece — before the first byte of `js/generated-y/**` is asked for. Nothing
// is downloading during that window and nothing is computing either.
//
// Meanwhile the page has been sitting at a keypress gate since 1.5 s. That gap
// is free bandwidth, and this file spends it: the tree the fallback rung is
// going to want is asked for at *page parse time*, from the earliest module
// the judge's page imports (js/jsmain.js), so the fetch overlaps the gate
// instead of starting after it.
//
// WHY `modulepreload` AND NOT `import()`. A preload link fetches and compiles
// a module graph without *evaluating* it. Evaluating it would run every C
// file-scope initialiser in the page realm — spending the one graph the
// main-thread rung is allowed to own, before a game has asked for one, on a
// page whose transport rung might well win. A preload only warms the cache:
// whoever imports it later gets a module-map hit and pays no network at all,
// and if nobody ever does, nothing was spent but bandwidth. Chrome (and the
// HTML spec) fetch a preloaded module's *dependencies* too, which is why four
// links cover a 180-module tree.
//
// WHY IT IS CONDITIONAL. On a fast link this is a pessimisation, not a win: the
// transport rung gets its four round trips almost free, wins the race outright,
// and needs `js/generated/**` — a *different* tree from the one preloaded here.
// Warming the wrong 2.7 MB on a link with no latency to hide costs bandwidth
// and buys nothing. So the preload is armed only when a round trip is
// expensive enough that the transport cannot win, which is exactly when the
// fallback rung is the one that will paint. See linkRttMs() for how that is
// asked, and js/boot/interactive.mjs's FALLBACK_HEAD_START_MS for the other
// half of the same policy.

// Everything this module reaches for exists only in a page. A worker realm has
// no document to put a link in, and Node has neither.
const IS_PAGE = typeof globalThis.document !== 'undefined'
    && typeof globalThis.performance !== 'undefined';

// Above this, a round trip is expensive enough that the transport rung — which
// needs the service-worker registration, a worker realm, and a synchronous
// interception probe before it can even begin fetching its engine — cannot
// paint first, and the main-thread rung is the one worth warming.
//
// The number is a measurement, not a preference. The transport's lead-in is
// four to six serialized round trips; the fallback's is two. On the mirror
// (RTT ~320 ms) that is a ~1.3 s handicap the transport never makes up, and the
// fallback wins every observed race. On loopback (RTT ~1 ms) the same handicap
// is ~5 ms and the transport wins every race, which is the behaviour worth
// keeping — it is genuinely faster per move. 25 ms is a decade of margin above
// same-machine and an order of magnitude below any real network.
export const SLOW_LINK_RTT_MS = 25;

/**
 * What one round trip to this origin costs, in milliseconds.
 *
 * Taken from the document's own navigation timing — `responseStart` is the
 * first byte of the document, `requestStart` the moment it was asked for, so
 * their difference is one round trip plus the server's think time. It is the
 * only latency figure available before this page has issued a request of its
 * own, and it is available the moment any script runs.
 *
 * Returns null when the browser will not say (no navigation entry, or a
 * cross-origin redirect that zeroes the timings) — in which case nothing is
 * preloaded, because guessing wrong costs bandwidth on the machine of somebody
 * who did not ask.
 */
export function linkRttMs() {
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (!nav || !nav.requestStart || !nav.responseStart) return null;
        const rtt = nav.responseStart - nav.requestStart;
        return rtt > 0 ? rtt : null;
    } catch { return null; }
}

// The fallback rung's whole graph, in the order it is discovered, so the link
// elements go out in the order the fetches would have gone out anyway.
//
// `../generated-y/__reset.js` is the load-bearing one: it is the reset barrel,
// which statically imports every module of the yieldable tree, so preloading it
// preloads all 180 of them. The three ahead of it are the boot chain between
// the fallback slot and that barrel, each of which is today a separate serial
// round trip.
//
// tools/c2js/build.mjs asserts, after every build, that each of these exists —
// a preload link at a path the mirror does not publish is a 404, and a 404 is a
// console line, and a console line fails the judge's browser check.
export const PRELOAD_PATHS = [
    './main-thread-engine.mjs',
    './harness-y.mjs',
    './reset-realm.mjs',
    '../generated-y/__reset.js',
];

let armed = false;

/**
 * Warm the fallback rung's module graph, if this looks like a link where the
 * fallback is going to be the rung that paints.
 *
 * Idempotent and silent: called from js/jsmain.js at module scope, which is the
 * earliest code this fork runs on the judge's play page.
 *
 * @param {{force?: boolean}} [opts] `force` skips the link test — the browser
 *   playability harness uses it to measure the preload on a loopback server.
 * @returns {boolean} whether anything was preloaded.
 */
export function preloadEngine(opts) {
    if (armed || !IS_PAGE) return false;
    // ?preload=0 turns it off, which is the floor every preload measurement is
    // taken against (tools/judge-sim/playability.mjs --no-preload). Read the
    // same defensive way the other page switches are.
    try {
        if (typeof location !== 'undefined' && location.search
            && new URLSearchParams(location.search).get('preload') === '0') return false;
    } catch { /* no location worth reading; carry on */ }

    if (!(opts && opts.force)) {
        // This fork's own index.html arms a real prewarm in its <head> — a
        // prepared, often warm transport realm, which is strictly better than a
        // warm cache — and the rung it will paint with wants js/generated/,
        // not the yieldable tree below. Warming the wrong tree beside it would
        // put both on the link at once, which is the thing this leg is for.
        if (globalThis.__NH_OWN_PAGE) return false;
        const rtt = linkRttMs();
        if (rtt === null || rtt < SLOW_LINK_RTT_MS) return false;
    }
    armed = true;

    const head = document.head || document.documentElement;
    for (const rel of PRELOAD_PATHS) {
        try {
            const link = document.createElement('link');
            link.rel = 'modulepreload';
            link.href = new URL(rel, import.meta.url).href;
            // Deliberately no `crossorigin` attribute: modulepreload's default
            // credentials mode is already "same-origin", which is what a module
            // script uses. Setting it to `anonymous` would put the preload on
            // the omit-credentials path, the later import would not match it,
            // and the tree would be fetched twice — the exact failure this file
            // exists to remove.
            head.appendChild(link);
        } catch { /* a document that will not take a link is not worth a line */ }
    }
    return true;
}
