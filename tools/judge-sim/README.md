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
