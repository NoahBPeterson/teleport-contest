# The transport ladder

How the browser build gets a thread that is allowed to block, why there are four
ways to try, and how each one fails without saying a word.

## The problem it solves

The transpiled corpus is straight-line synchronous C. `tty_nhgetch()` calls
`getchar()` and expects a byte back on the same call stack — there is no way to
suspend a synchronous JS stack mid-flight and resume it later. So an interactive
port has two options: re-run the whole key prefix on every keystroke (correct,
and ~100x too slow), or put the engine on a thread that is *allowed to block*
and hand it keys through something synchronous.

Blocking needs a primitive. There are exactly two in a browser:

- `Atomics.wait()` on a `SharedArrayBuffer`, which needs the page to be
  `crossOriginIsolated`, which needs COOP/COEP headers. GitHub Pages — where
  `mazesofmenace.ai/play/<owner>/` is hosted — does not send them and cannot be
  made to.
- a **synchronous `XMLHttpRequest`** that somebody declines to answer until
  there is a key to answer with. `js/sw.js` is that somebody: a service worker
  that parks the request and resolves it when the page posts a keystroke.

The second one is the path every real player takes, and it has a precondition
that is easy to get wrong: the realm making the request has to be a *controlled
service-worker client*.

## Why controlled-ness is the hard part

The mirror publishes only `js/**`, `frozen/**` and `index.html`. A service
worker's scope is capped at its own directory unless the host sends
`Service-Worker-Allowed`, which static hosting does not — so `js/sw.js` has
scope `/js/`, and **the page at `/` can never be a controlled client**. That is
fine, because the page is not what blocks. What blocks is a worker, and the
worker's script lives under `/js/`.

Whether that is enough depends on the engine:

| realm | is it matched by its own script URL? |
| --- | --- |
| the page at `/` | no — outside the scope, never controlled |
| dedicated worker, script under `/js/` | **it depends on the browser** |
| SharedWorker, script under `/js/` | yes, in every engine |

A dedicated worker is supposed to be a service-worker client in its own right,
matched by its own script URL. Current Chromium does exactly that. Older
Chromium (before dedicated workers became independently-loaded targets)
*inherited the creating document's controller* instead — and the creating
document here is the page at `/`, which has no controller. Same page, same
service worker, same code, opposite outcome depending on the browser build.

A SharedWorker has no single creating document to inherit from, so every engine
has always had to match it by its own script URL. That is the whole reason the
third rung exists.

This matters because a transport that is trusted *wrongly* does not fail. It
hangs, inside `getchar()`, forever.

## The ladder

`js/boot/interactive.mjs`, `InteractiveEngine.start()`. Tried in order; every
rung falls through in silence.

| # | mode | host | blocks on | measured |
| --- | --- | --- | --- | --- |
| 1 | `sab` | dedicated worker (Node: `worker_threads`) | `Atomics.wait` on a SharedArrayBuffer | 0.63 ms/move |
| 2 | `xhr` | dedicated worker, `js/boot/engine-worker.mjs` | sync XHR parked by `js/sw.js` | 1.3–3.0 ms/move |
| 3 | `xhr-shared` | SharedWorker, `js/boot/shared-engine.js` | same | 1.1–1.3 ms/move |
| 4 | `replay` | module worker per replay | nothing — re-runs the key prefix | ~145 ms/move |

Rung 1 needs `crossOriginIsolated`, so in production it is Node-only. Rungs 2
and 3 need the service worker to intercept, which is *proved*, not assumed —
see below. Rung 4 is `ReplayEngine`: correct, amortized, and roughly a hundred
times too slow to pass a playability check. It exists so an exotic browser still
*plays* rather than showing a dead terminal, and it puts a banner on the page
saying so (`warnDegradedEngine()` in `js/jsmain.js`).

### What each rung protects against

- **rung 1** — nothing, in production. It is what Node uses and what a
  COOP/COEP host would use.
- **rung 2** — the normal path. Fast, one worker, no extra moving parts.
- **rung 3** — a Chromium where a dedicated worker is not a client of its own.
  This is the leading suspect for the judge run that fell through to replay:
  everything the page can observe says the service worker is there, and the
  engine's request goes to the network anyway.
- **rung 4** — no service worker at all (a browser with them disabled, a
  private-mode profile, a mirror that failed to publish `js/sw.js`).

### Why rung 3 is a classic script

Chromium does not implement module SharedWorkers, and does not say so.
`new SharedWorker(url, {type:'module'})` throws nothing, fires no `error` event,
prints no console line — the worker simply never starts. Measured on Chrome 139
headless: an identical pair of shared workers, classic and module, and only the
classic one ever answers.

So `js/boot/shared-engine.js` is a classic script. A classic script cannot
`import` at the top level, but it *can* `import()`, which Chromium allows inside
classic workers (verified on the same build, for both dedicated and shared
workers). The file is a three-line shim that pulls in `js/boot/engine-worker.mjs`
and hands it the port; both worker types then run byte-identical engine code.

That silent-failure mode is also why every rung is bounded by a timeout
(`READY_TIMEOUT_MS`, `PROBE_TIMEOUT_MS`) rather than waiting for an error that
may never come.

## The interception probe

Registering is not intercepting. `navigator.serviceWorker.register()` resolving,
and `reg.active` being set, are both visible from the page and neither answers
the only question that matters: *will a request from the realm that is about to
block actually reach the service worker?* Nothing but a request from that realm
can answer it.

So before the engine boots, the driver posts `{type:'probe', probeUrl}` to the
worker, and the worker answers with one **synchronous** XHR from its own realm
(`swIntercepts()` in `js/boot/engine-worker.mjs`). Synchronous because the answer
decides whether that realm may block, so it has to be known first, in the right
thread.

The URL is the important part:

```
/js/sw.js?__nhprobe=<nonce>
```

- `js/sw.js` **certainly exists** on the mirror — it is published with `js/**`.
- static hosts ignore the query string, so the network answers with that file's
  own bytes, HTTP 200.
- `js/sw.js`'s fetch handler answers *any* in-scope URL carrying `__nhprobe`
  with the marker body `__nh_sw_alive__`.

Intercepted → marker. Not intercepted → the real file, 200. **Either answer is a
success at the HTTP level**, which is the entire point: the previous design
probed `/js/__nhkey?probe=1`, a URL only the service worker can answer, so a
realm that was not intercepted got a **404** — and a 404 is a line in the browser
console ("Failed to load resource: the server responded with a status of 404").
The judge's playability check fails an entry on *any* console output, so the old
probe failed the run in the very act of noticing it should degrade. A probe that
cannot fail is a probe that cannot be heard.

The nonce keeps the HTTP cache out of it: a cached 200 from an earlier attempt
would answer for a service worker that is no longer there.

## Silence, and how it is measured

Zero console output is a hard requirement on every path, so the judge simulator
was taught to see what the judge sees. `tools/judge-sim/playability.mjs` now
collects console output two ways:

- **Chrome `--enable-logging=stderr`** — console API calls and uncaught
  exceptions, page only. This is what the tool used to check, and it is *too
  generous*: it reports zero for several things a judge would count.
- **CDP `Log` + `Runtime`, on every target** — one WebSocket to the browser
  endpoint with flattened auto-attach, so the page, its dedicated workers,
  shared workers and service workers all report. This adds network-level
  entries: subresource 404s, failed service-worker registrations, CSP
  violations.

The second list is the one that decides the verdict. Chrome is now launched on
`about:blank` and navigated over CDP so `Log`/`Runtime` are enabled before the
page runs a line of script.

Two stand-in-only 404s were removed from the simulator so that a zero there means
zero: `/favicon.ico` (the real origin has one; only this server, which hosts the
fork at the origin root, would 404 it) and `/snapshot.json` (written by the
mirror's publisher, not present in the fork tree).

Everywhere else, silence is deliberate:

- worker `error` events are marked handled with `preventDefault()`, which keeps
  them out of the console; the ladder steps down, or `js/jsmain.js` puts the
  crash on the page.
- `js/boot/shared-engine.js` swallows a failed `import()` — the driver's timeout
  handles it.
- the degradation notice for rung 4 is a banner in the DOM, never a
  `console.warn`.

## Verification matrix

All runs: Chrome 139 headless (`--headless=new`), macOS, `judge-sim` mirror
server (no COOP/COEP unless noted), 24 keys `hjkl`×6, from the repo root.

| what | command | rung reached | ms/move | 404s | CDP console |
| --- | --- | --- | --- | --- | --- |
| production shape | `playability.mjs --keys=…` | `xhr` | 1.3–3.0 | 0 | 0 |
| ditto, 243 moves | `playability.mjs` | `xhr` | 2.97 | 0 | 0 |
| rung 2 alone | `playability.mjs --transport=worker …` | `xhr` | 1.30 | 0 | 0 |
| rung 3 alone | `playability.mjs --transport=sharedworker …` | `xhr-shared` | 1.12 | 0 | 0 |
| **rung 2 → rung 3** | `playability.mjs --sw-deny-dedicated …` | `xhr-shared` | 1.28 | 0 | 0 |
| SW registers, never intercepts | `playability.mjs --inert-sw …` | `replay` | 146 | 0 | 0 |
| `js/sw.js` missing | `playability.mjs --no-sw …` | `replay` | 144 | 1 | **1** |
| ladder narrowed to replay | `playability.mjs --transport=replay …` | `replay` | 356 | 0 | 0 |
| crossOriginIsolated | `playability.mjs --coi --keys=…` | `sab` | 0.63 | 0 | 0 |

Every run consumed all 24 keys with `gameover: false`, and the status line shows
a real character in the dungeon rather than a prompt loop.

Scoring and the Node path are unaffected:

| what | result |
| --- | --- |
| `tools/judge-sim/run.mjs seed8000-tourist-starter.session.json` | PASS, 0 mismatches, 0 out-of-scope |
| `tools/judge-sim/run.mjs seed0013-friday13-save-then-fullmoon-restore.session.json` | PASS (multi-segment) |
| `frozen/ps_test_runner.mjs` on seed8000 + seed4500 | 2/2 PASS, RNG 111405/111405, screens 1837/1837 |
| `frozen/playability_runner.mjs` seed8000 | runs, 22 moves, 36.7 ms/move (43.2 before this change — same, within noise) |
| `frozen/playability_runner.mjs` seed4500 | runs, 1813 moves, 2.22 ms/move |

### New judge-sim switches

- `--transport=worker|sharedworker|sab|replay` — narrows the ladder to one rung.
  Honoured by `transportOverride()` in `js/boot/interactive.mjs`, which can only
  ever *remove* rungs, so it cannot make a browser look more capable than it is.
- `--inert-sw` — serves a service worker that registers and activates normally
  and intercepts nothing. Reproduces "the probe says no" without needing a
  browser that gets worker control wrong.
- `--sw-deny-dedicated` — serves the real `js/sw.js` with its probe answer made
  conditional on `Client.type`: a dedicated worker is told "not intercepted", a
  SharedWorker is told the truth. This is the only way to stage the actual
  rung-2-fails-rung-3-catches handoff, since Chromium has no flag that makes it
  stop controlling dedicated workers. The patch is a string replacement against
  a known line of `js/sw.js` and **throws** if that line moves, so it cannot
  silently start testing the opposite of what it claims.

## What could not be verified, and residual risk

- **A browser that actually fails rung 2.** No Chromium available here gets
  dedicated-worker control "wrong", so rung 2's real-world failure was staged
  with `--sw-deny-dedicated` (the service worker declining) rather than observed
  (the browser declining). The realm sees the same thing either way — its
  request reaching the network — but the staging is one step removed from the
  condition it stands in for.
- **Browsers other than Chrome 139.** Firefox and Safari were not exercised.
  The rung-3 argument (SharedWorkers matched by their own script URL) is a spec
  guarantee rather than a measured one there. Firefox and Safari both support
  classic SharedWorkers and `import()` inside classic workers.
- **A browser with no `SharedWorker`.** Guarded with `typeof SharedWorker !==
  'undefined'`; such a browser skips rung 3 and lands on rung 4. Not
  reproducible here — this headless Chrome has `SharedWorker`.
- **A browser old enough to lack `import()` in classic workers.** Rung 3's shim
  needs it. Roughly the same vintage of Chromium that would fail rung 2, so on a
  genuinely old build both rungs may fail and the page lands on rung 4 — slow,
  but silent and correct.
- **One unavoidable console line.** If the mirror ever fails to publish
  `js/sw.js`, `navigator.serviceWorker.register()` logs *"A bad HTTP response
  code (404) was received when fetching the script"* — emitted by the browser,
  not by us, and not suppressible by catching the rejection. There is no way to
  ask a browser whether a URL exists without a 404 being logged if it does not,
  so this cannot be pre-flighted away either. It is the `--no-sw` row above, and
  it is unreachable on a correctly published mirror, where `js/sw.js` ships with
  everything else under `js/**`. The realistic version of the same fallback —
  `--inert-sw` — is silent.
- **An orphaned SharedWorker.** A SharedWorker has no `terminate()`; abandoning
  one closes its port and leaves the worker to be reaped when the page goes
  away. If rung 3 is abandoned *while its probe XHR is still outstanding* (the
  5 s timeout), that worker stays parked until then. Each engine names its
  SharedWorker uniquely, so an orphan can never be reconnected to by a reload
  and mistaken for a live game.
