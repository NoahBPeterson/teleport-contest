# judge-sim — reproduce the judge's browser round locally

The contest mirror (`mazesofmenace.ai/play/<owner>/`) publishes **only** `js/**`
and `frozen/**`. A module graph that reaches anywhere else works on disk and
404s in the judge's browser, which scores 0/0 — that is exactly what happened
when the vendored game data still lived in a top-level `data/`.

    node tools/judge-sim/run.mjs <session-file-name> [--keep] [--timeout=ms]

does the whole round:

1. `server.mjs` serves the tree with the mirror's shape (js/ + frozen/ only,
   everything else 404) and logs every request, tagged IN-SCOPE / HARNESS /
   BLOCKED.
2. `node-ref.mjs` replays the session through `js/jsmain.js` in Node and
   SHA-256s each segment's screens / cursors / RNG log.
3. Real headless Chrome loads `driver.html`, which imports `/js/jsmain.js`,
   replays the same session with one shared storage handle, and posts back the
   same digests.
4. The two are diffed. Equal digests ⇒ the browser's `runSegment` output is
   byte-identical to Node's, so the browser scores what Node scores.

Exit status is 0 only when every segment matches **and** nothing outside
`js/**` + `frozen/**` was requested. (`/favicon.ico` is tagged BROWSER-UA: Chrome
asks for it on its own, it is in no module graph, and the mirror 404s it
harmlessly.)

Override the browser with `CHROME=/path/to/chrome`.

## The reset differential

    node tools/judge-sim/reset-diff-browser.mjs [--pairs A:B,…] [--noop]

`tools/reset-diff.mjs` proves in Node that resetting the transpiled module graph
is indistinguishable from forking a fresh one; it is a Node tool because its
*reference* — a genuinely fresh graph per segment — comes from
`module.registerHooks`. A page has none. It does have a module Worker, which is
a fresh realm with a fresh module map, i.e. a genuinely fresh graph, and
`js/boot/frame.mjs` already is one. So the reference is buildable here, out of
the mechanism the reset replaces.

    reference   session B, one throwaway frame.mjs Worker realm PER SEGMENT
    test        session A then session B, both through js/jsmain.js's
                runSegment, in ONE page realm that resets between segments

Two things make a pass mean something, and neither is optional:

- `--noop` patches `Realm.prototype.reset` to a no-op that reports success
  (`--force-noop`'s browser twin). **Every** pair must then FAIL; the exit code
  is inverted so that "all failed" is a pass.
- the page counts every `new Worker` and attributes it. A test side that built
  any means `runSegment` fell back off the reset, so the run compared the
  reference against itself — a FAIL here whatever the digests say.

See `docs/NOTES-resettable-state.md` §10.
