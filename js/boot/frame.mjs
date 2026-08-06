// frame.mjs — one segment, one realm.
//
// This file is the entry point of a module Worker. A Worker is a fresh
// ECMAScript realm with its own module map, so importing ./harness.mjs here
// instantiates a brand-new copy of the 172-module transpiled graph — every C
// file-scope variable back at its static initialiser — no matter how many games
// the page has already played. That is the browser answer to the problem
// js/boot/isolation.mjs solves in Node with module.registerHooks: the judge's
// save/restore sessions replay segment 2 into segment 1's C globals otherwise
// (measured on seed0030: 196151 RNG draws instead of 70591).
//
// A Worker was picked over a same-origin <iframe> because it needs no DOM (the
// judge may drive us from a worker already), no document.body to attach to, and
// nothing in the scoring path touches the DOM — harness.mjs is a pure string
// terminal over an in-memory VFS.
//
// Protocol (see js/jsmain.js):
//   worker → page  { type: 'ready' }
//   page   → worker { type: 'run', job }        job.storage is a plain object
//   worker → page  { type: 'done', ok, result | error, storage }

import { installBrowserGlobals } from './browser-env.mjs';

installBrowserGlobals();

// The judge's storage handle cannot be structured-cloned (it is an object with
// methods), so the page sends a snapshot and gets one back; harness.mjs only
// ever touches a single key, but this stays generic.
function storageHandleOver(map) {
    return {
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
        get length() { return map.size; },
        key(i) { let n = 0; for (const k of map.keys()) { if (n === i) return k; n++; } return null; },
    };
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'run') return;
    const map = new Map(Object.entries(msg.job.storage || {}));
    let out;
    try {
        const { runBootGame } = await import('./harness.mjs');
        const r = await runBootGame({
            seed: msg.job.seed,
            datetime: msg.job.datetime,
            nethackrc: msg.job.nethackrc || '',
            moves: msg.job.moves || '',
            storage: storageHandleOver(map),
        });
        if (r.error) throw r.error;
        out = {
            type: 'done', ok: true,
            result: {
                screens: r.screens || [],
                cursors: r.cursors || [],
                rngLog: r.rngLog || [],
                animFramesByStep: r.animFramesByStep || [],
                // null == "ran out of the moves we were given" (the normal end
                // of a scored segment); anything else is the game itself
                // terminating. Scoring ignores it; the interactive fallback in
                // js/boot/interactive.mjs needs it to know the game is over.
                exitCode: r.exitCode === undefined ? null : r.exitCode,
            },
            storage: Object.fromEntries(map),
        };
    } catch (e) {
        // Errors are not reliably cloneable across every engine; send text.
        out = { type: 'done', ok: false, error: String((e && e.stack) || e), storage: Object.fromEntries(map) };
    }
    self.postMessage(out);
};

self.postMessage({ type: 'ready' });
