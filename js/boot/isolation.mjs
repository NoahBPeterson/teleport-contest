// isolation.mjs — give every segment its own copy of the transpiled module graph,
// in-process.
//
// THE PROBLEM. js/generated/* is transpiled C: every C file-scope variable is a
// module-scope variable, so re-running main() in a module graph that already
// played a game starts from the previous game's globals. Replaying segment 2 of
// a save/restore session that way desynchronises immediately (measured: seed0030
// went from 70591 to 196151 RNG draws). The old fix was one child process per
// segment (js/boot/worker.mjs), which the judge forbids — it runs us under
// `node --permission` with no child processes and no worker threads — and which
// a browser cannot do at all.
//
// WHY THE OBVIOUS FIX DOESN'T WORK. `import('./harness.mjs?seg=2')` really does
// create a second harness module... and nothing else. ESM resolves a static
// specifier against the *directory* of the importer, so `./allmain.js` inside
// `unixmain.js?seg=2` resolves to plain `allmain.js` — the query is dropped one
// level down and the other 171 generated modules stay shared. (Node also
// realpaths file: URLs, so `//`, `/./` and percent-encoding tricks all collapse
// to the same key; the query string is the only thing that survives.)
// Rewriting the graph into data:/blob: URLs can't work either: the generated
// graph is cyclic, and a cyclic graph of content-addressed URLs is impossible to
// construct — A's URL depends on B's content which depends on A's URL.
//
// WHAT WE DO. Install a synchronous ESM resolve hook that propagates the query:
// any relative specifier resolved from a parent already tagged `?c2jsseg=N` gets
// the same tag. So `import(harness + '?c2jsseg=2')` pulls a completely fresh
// 172-module graph, and cycles are fine because the URLs are computed from the
// path, not from content. Module.registerHooks is synchronous and in-thread
// (unlike module.register, which spins up a worker), so it is legal under
// `--permission` with no extra allowances.
//
// BROWSERS. There is no node:module there; the same trick is expressible as an
// import map (map `/js/generated/` to a per-segment prefix served by a service
// worker) or by hosting each segment in a fresh iframe realm. Until that exists,
// enableSegmentIsolation() reports false and runSegment falls back to a shared
// graph — correct for single-segment sessions, which is 40 of the 44 public
// ones. Nothing in this file is imported eagerly by the browser: the node:module
// specifier is computed, so a bundler will not try to resolve it.

/** Query key stamped onto per-segment module URLs. */
export const SEG_KEY = 'c2jsseg';

// Modules that are pure immutable data and must stay shared: duplicating the
// 2.2 MB vendored playground per segment would be pointless parse + heap.
const SHARED = /\/data\/nethackdir\//;

function resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const parent = context.parentURL;
    if (!parent) return result;
    const q = parent.indexOf('?' + SEG_KEY + '=');
    if (q < 0) return result;
    const url = result.url;
    // node: builtins carry no query; already-tagged URLs are done; shared data
    // modules opt out.
    if (!url.startsWith('file:') || url.includes('?') || SHARED.test(url)) return result;
    return { ...result, url: url + parent.slice(q), shortCircuit: true };
}

let state = null; // null = untried, true/false = resolved

/**
 * Install the per-segment resolve hook (idempotent).
 * @returns {Promise<boolean>} true when `?c2jsseg=N` will fork the whole graph.
 */
export async function enableSegmentIsolation() {
    if (state !== null) return state;
    state = false;
    try {
        if (typeof process === 'undefined' || !process.versions || !process.versions.node) return state;
        // Computed specifier: keeps browser bundlers from trying to resolve it.
        const nodeModule = 'node:' + 'module';
        const mod = await import(nodeModule);
        // registerHooks (Node >= 22.15 / >= 23.5) runs hooks synchronously on
        // this thread. module.register() would work too but starts a worker,
        // which --permission blocks without --allow-worker.
        if (typeof mod.registerHooks !== 'function') {
            warnDegraded(`node ${process.versions.node} has no module.registerHooks (needs >= 22.15)`);
            return state;
        }
        mod.registerHooks({ resolve });
        state = true;
    } catch (e) {
        warnDegraded(String((e && e.message) || e));
        state = false;
    }
    return state;
}

// Silent degradation would look like a scoring bug, not a platform gap: only
// multi-segment sessions are affected, and only from their second segment on.
function warnDegraded(why) {
    try {
        process.stderr.write(
            `[c2js] per-segment module isolation unavailable (${why}); `
            + 'segments after the first in a session will replay into the previous '
            + "segment's C globals.\n",
        );
    } catch {}
}

/** Module specifier for segment `n` of `baseUrl`, isolated when possible. */
export function segmentSpecifier(baseUrl, n, isolated) {
    return isolated ? `${baseUrl}?${SEG_KEY}=${n}` : baseUrl;
}
