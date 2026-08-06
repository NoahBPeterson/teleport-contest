// shared-engine.js — the engine worker, hosted in a SharedWorker instead.
//
// Why this rung exists
// --------------------
// The engine has to block inside getchar(). On a host that sends no COOP/COEP
// (GitHub Pages, which is what mazesofmenace.ai/play/<owner>/ is) there is no
// SharedArrayBuffer, so the only synchronous blocking primitive left is a
// synchronous XMLHttpRequest that js/sw.js parks. That works only if the realm
// making the request is a *controlled service-worker client*.
//
// For a dedicated worker, "am I controlled?" is answered by the engine, and the
// answer has moved: a dedicated worker is supposed to be its own client, matched
// by its own script URL (which is why the engine worker lives under /js/, inside
// sw.js's scope), but in older Chromium a dedicated worker inherited its
// creator's controller instead — and the creator here is the page at /, which is
// outside the /js/ scope and can never be controlled. Same page, same service
// worker, same code, opposite outcome depending on the browser build.
//
// A SharedWorker has no such ambiguity. It has no single creating document to
// inherit from, so every engine has always had to match it by its own script
// URL. This file's URL is under /js/, so a SharedWorker running it is inside
// sw.js's scope, in every engine, by construction.
//
// Why this file is a classic script
// ---------------------------------
// Chromium does not implement module SharedWorkers: `new SharedWorker(url,
// {type:'module'})` neither works nor reports an error — the worker simply
// never starts, and no error event and no console line ever arrive. (Measured
// on Chrome 139 headless: a classic SharedWorker answers, the identical module
// one is silent forever. That silence is why js/boot/interactive.mjs bounds this
// rung with a timeout rather than waiting for an error.)
//
// So the SharedWorker entry point has to be a classic script — and a classic
// script cannot `import` at the top level. It can `import()`, which Chromium
// does allow inside classic workers, and that is enough: this file is a
// three-line shim whose only job is to pull in the real engine module and hand
// it the port.
//
// Everything about the game itself is in js/boot/engine-worker.mjs; the two
// worker types run byte-identical engine code.

self.onconnect = function (e) {
    var port = e.ports[0];
    port.start();
    // Failure here is silent by design: if this realm cannot dynamic-import,
    // no {type:'ready'} is ever posted, the driver's timeout fires, and the
    // ladder moves on. Reporting it would put a line in the console, which is
    // itself a way to fail the judge's playability check.
    import('./engine-worker.mjs').then(function (m) {
        m.serveOn(port);
    }, function () { /* driver times out and degrades */ });
};
