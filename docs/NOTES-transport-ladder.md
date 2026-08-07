# The transport race

How the browser build gets a thread that is allowed to block, why there are four
ways to try, why they are now tried *at the same time*, and how each one fails
without saying a word.

> This file used to be called "the transport ladder", and the ladder is the
> thing that broke. The four transports and the interception probe are
> unchanged; what changed is that they are no longer tried one after another,
> because the failure that matters is a transport that hangs, and a ladder pays
> for every hanging rung in wall-clock time before the page can paint anything.
> See [The race](#the-race).

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
SharedWorker transport exists.

This matters because a transport that is trusted *wrongly* does not fail. It
hangs, inside `getchar()`, forever.

## The four transports

`js/boot/interactive.mjs`.

| # | mode | host | blocks on | measured |
| --- | --- | --- | --- | --- |
| 1 | `sab` | dedicated worker (Node: `worker_threads`) | `Atomics.wait` on a SharedArrayBuffer | 1.2 ms/move |
| 2 | `xhr` | dedicated worker, `js/boot/engine-worker.mjs` | sync XHR parked by `js/sw.js` | 2.2–2.7 ms/move |
| 3 | `xhr-shared` | SharedWorker, `js/boot/shared-engine.js` | same | 2.2–2.4 ms/move |
| 4 | `replay` | module worker per replay | nothing — re-runs the key prefix | ~21 ms/move |

Transport 1 needs `crossOriginIsolated`, so in production it is Node-only.
Transports 2 and 3 need the service worker to intercept, which is *proved*, not
assumed — see below. Transport 4 is `ReplayEngine`: correct, amortized, and an
order of magnitude too slow to pass a playability check. It exists so an exotic
browser still *plays* rather than showing a dead terminal, and it puts a banner
on the page saying so (`warnDegradedEngine()` in `js/jsmain.js`).

### What each transport protects against

- **1** — nothing, in production. It is what Node uses and what a COOP/COEP host
  would use.
- **2** — the normal path. Fast, one worker, no extra moving parts.
- **3** — a Chromium where a dedicated worker is not a client of its own.
  Everything the page can observe says the service worker is there, and the
  engine's request goes to the network anyway.
- **4** — no service worker at all (a browser with them disabled, a private-mode
  profile, a mirror that failed to publish `js/sw.js`), or a service worker that
  is there and does not answer.

## The race

The four used to be a ladder: try one, wait for it to fail, try the next. That
is fine when a transport fails *fast*, and it is fatal when one fails by
*hanging* — which is exactly the interesting failure here. A service worker that
never answers, a registration that never settles, a SharedWorker that Chromium
accepts and never starts: each of those cost a full timeout (`READY_TIMEOUT_MS`
6 s, `PROBE_TIMEOUT_MS` 5 s, per rung) before the next rung was even attempted,
and the fallback engine only started booting after all of them.

The judge's browser check gives a session about three seconds to paint
something. Measured against us, three crawls running: `browser_ok: true`,
`error_class: None`, **0 moves in 88 sessions**. No error, no console output,
nothing to look at — which is precisely what "still walking down the ladder when
the clock ran out" looks like from outside. Reproduced here with `--hang-sw`
(below): first frame at **11 481 ms**.

So `startEngine()` races instead:

1. **Both XHR transports come up together.** One service-worker registration,
   then both realms spawn and probe in parallel. That half is cheap — a worker
   with nothing in it and one same-origin request each — and it is where all the
   hanging happens.
2. **Only the winner boots a game.** `_prepare()` (spawn, ready, probe) runs
   everywhere; `_boot()` runs once, in whichever realm proved first that it can
   block. So the expensive part still costs exactly one boot, as it did with the
   ladder.
3. **The fallback boots alongside them**, `FALLBACK_HEAD_START_MS` (700 ms)
   behind, and that wait is cut short the moment the transports are known to
   have failed. The first engine to paint a frame is the one the page gets.
4. **Losers are retired at once** — worker killed, service-worker lane closed
   (see below), replay realm terminated mid-boot.

The first frame therefore costs `min(transport, fallback)` in every realm,
instead of the sum of every timeout in front of it.

### Why the fallback gets a head start

Not for correctness — the race would sort that out — but because both boots want
the same CPU for the same ~1 s of module instantiation. A working transport
paints at ~1.2 s here and a replay realm at ~1.0 s, so with no head start the
fallback would win about half of all *healthy* page loads, and the first few
keystrokes would be paid at replay prices for nothing. 700 ms is enough that a
working transport wins outright, and short enough that the worst case
(head start + replay boot ≈ 1.9 s) is well inside the judge's patience.

### Why the dedicated worker still wins ties

The two XHR transports come up within tens of milliseconds of each other, so
without a tiebreak the production path would be whichever one Chrome happened to
schedule first — a different answer on different loads. `PREFER_GRACE_MS`
(300 ms) makes the list a preference rather than a coin toss: a transport that
comes up second waits that long for the one in front of it, and not at all if
the one in front has already failed. The dedicated worker is first in the list
because it is the ordinary, best-tested path; `--sw-deny-dedicated` still lands
on the SharedWorker, and pays the 300 ms once.

### The timeouts are now the second line of defence

`READY_TIMEOUT_MS` 6000 → **2500**, `PROBE_TIMEOUT_MS` 5000 → **1000**, the
registration-activation wait 5000 → **2500**. They no longer bound the first
frame — the race does — so they only have to bound *waste*: a worker that is
going to say `ready` says it as soon as it has a message loop, and a probe is
one same-origin request the service worker answers from memory.

## One key lane per realm

Racing realms are parked on `/js/__nhkey` at the same time, and `js/sw.js` used
to keep one queue for the whole page: the player's keystroke went to whichever
realm asked last, possibly one the driver had already abandoned. Each realm now
carries a token (`?t=<token>` on the key URL, `token` on the message) and gets a
queue of its own.

`{type:'nhclose', token}` answers whatever a retired realm has parked with EOF.
That is the only way to retire a **SharedWorker** at all — it has no
`terminate()`, so an engine parked in `getchar()` over there has to be given
something to unwind on, or it holds the key endpoint for the rest of the page's
life. (It also fixes a hazard that predates the race: starting a second game
posted `-1` to stop the first, and with one shared queue the *new* engine could
pick that up as its own first key and exit before it began.)

## The upgrade swap

If the fallback wins the race, the transport is not thrown away. When it comes
up, `RacedEngine._swapIn()`:

- feeds it every key played so far — a resident engine being typed at, not a
  replay being re-run, so the prefix costs ~0.3 ms/key plus one service-worker
  round trip;
- swaps it in **between two keystrokes** (all steps and the swap share one
  promise chain, so a swap can never land inside a keystroke);
- retires the replay realm.

From that keystroke on the game costs ~2 ms/move instead of ~21. Nothing is said
about any of it — there is no banner, no console line; the swap is invisible
except in how fast the game answers. The degradation banner is only raised when
the transports have *definitively* failed and the replay engine is what the
player is really stuck with, which may now be learned after the first frame.

If the game ended during the replayed prefix, the newcomer is retired instead
and the fallback keeps the game: it is the engine holding the screen the player
has seen.

### Why the SharedWorker engine is a classic script

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

That silent-failure mode is why every transport is bounded by a timeout
(`READY_TIMEOUT_MS`, `PROBE_TIMEOUT_MS`) rather than waiting for an error that
may never come — and, in the end, why the transports are raced rather than
laddered: a failure that says nothing can only be told from a slow success by
waiting, and waiting was the thing that cost us the run.

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
  them out of the console; the race drops that transport, or `js/jsmain.js` puts
  the crash on the page.
- `js/boot/shared-engine.js` swallows a failed `import()` — the driver's timeout
  handles it.
- the degradation notice for transport 4 is a banner in the DOM, never a
  `console.warn`.
- every promise in the race has its handlers attached before any of them can
  settle, so a losing transport can never surface as an unhandled rejection —
  which is a console line.

## A page that says it is Node

The judge's pages are not blank pages. They install a `process` stub with
`versions.node` set, plus an import map aiming `node:*` at shims of their own —
confirmed in the Session Viewer, and every indication says the playability
harness too. Every environment check in this port used to ask only "is there a
`process.versions.node`?", so **inside those pages the port believed it was
running in Node**:

| file | what it did in their page |
| --- | --- |
| `js/jsmain.js` | skipped the whole browser branch, so the spent-realm guard never ran: session 2 booted NetHack into session 1's C globals |
| `js/boot/interactive.mjs` | tried to host the engine on `node:worker_threads`, which resolves to a shim there and cannot make a thread — no engine, no first frame |
| `js/boot/isolation.mjs` | imported their `node:module`, found no `registerHooks`, and wrote a Node-shaped warning to `process.stderr` — which in their page is `console.error` |

That is a second, independent way to produce "0 moves, no error class" — and in
the viewer's case it produced a `TypeError: Cannot read properties of null
(reading 'buf')` out of raw generated code, plus a console line.

No amount of asking `process` nicer questions fixes it, because `process` is
theirs. What a realm *is* cannot be faked from a page: no Node has `window` or
`WorkerGlobalScope`, and every browser realm we run in — page, dedicated worker,
shared worker — has one of them. So all three checks now read

```js
const IS_BROWSER = typeof globalThis.window !== 'undefined'
    || typeof globalThis.WorkerGlobalScope !== 'undefined';
const IS_NODE = !IS_BROWSER && typeof process !== 'undefined'
    && !!(process.versions && process.versions.node);
```

Node's own answer is unchanged (it has neither global), so the scoring path is
untouched — 44/44 sandbox parity, 0 static violations. `--judge-stub` serves our
pages inside a host of exactly that shape, and `--viewer` drives
`tools/judge-sim/viewer-repro.html` (one import of `js/jsmain.js`, three
sessions through it) so the multi-session case is measured rather than argued:

| | before | after |
| --- | --- | --- |
| `playability.mjs --judge-stub` | `replay`, 1 `console.error` | `xhr`, first frame 1013 ms, 0 console |
| `playability.mjs --viewer --judge-stub` | 1/3 sessions, two `TypeError: … (reading 'buf')`, 1 `console.error` | 3/3 sessions (incl. multi-segment), 0 console |
| `playability.mjs --viewer` (no stub) | 3/3, 0 console | 3/3, 0 console |

## Verification matrix

All runs: Chrome 139 headless (`--headless=new`), macOS, `judge-sim` mirror
server (no COOP/COEP unless noted), 243 keys, from the repo root. `first frame`
is navigation start to the first painted frame (`first_frame_ms` in the bench
report) — the clock the judge's check is really watching.

| what | command | engine | first frame, before → after | ms/move, before → after | CDP console |
| --- | --- | --- | --- | --- | --- |
| production shape | `playability.mjs` | `xhr` | 1231 → **1179** | 2.45 → 2.44 | 0 |
| crossOriginIsolated | `--coi` | `sab` | 1153 → **1141** | 1.20 → 1.19 | 0 |
| SharedWorker alone | `--transport=sharedworker` | `xhr-shared` | 1377 → **1157** | 2.43 → 2.29 | 0 |
| dedicated fails, shared catches | `--sw-deny-dedicated` | `xhr-shared` | 1162 → **1139** | 2.41 → 2.67 | 0 |
| SW registers, never intercepts | `--inert-sw` | `replay` | 1031 → **1200** | 20.98 → 20.54 | 0 |
| `js/sw.js` missing | `--no-sw` | `replay` | 1174 → **1188** | 20.79 → 20.73 | **1** |
| **SW answers nothing** | `--hang-sw` | `replay` | **11 481 → 1879** | 20.61 → 21.53 | 0 |
| **judge-shaped host page** | `--judge-stub` | `replay` → **`xhr`** | 1172 → **1013** | 20.41 → 2.63 | **1 → 0** |
| narrowed to replay | `--transport=replay` | `replay` | — | 21.03 | 0 |
| `--transport=sab`, no COI | `--transport=sab` | `replay` | — | 20.63 | 0 |

Every run consumed all 243 keys with `gameover: false`, 0 out-of-scope requests,
and a status line showing a real character in the dungeon rather than a prompt
loop.

The two rows that matter are the two that used to be unmeasurable. `--hang-sw`
is the reported failure: **11.5 s to first frame** against a ~3 s budget, which
is 0 moves and no explanation. `--judge-stub` is the second, independent cause,
and it was not slow at all — it was silently taking the Node path in a browser.

Because a single run is noisy, the two transport modes were sampled four to five
times each (medians):

| | first frame | ms/move |
| --- | --- | --- |
| default, before | 1277 (max **2065**) | 2.47 |
| default, after | 1194 (max 1410) | 2.38 |
| `--coi`, before | 1258 | 1.25 |
| `--coi`, after | 1141 | 1.19 |

No regression in either mode; the ladder's *variance* is gone with it.

### Upgrade-swap correctness

`--transport-delay=<ms>` holds the transports back so the fallback demonstrably
wins and the swap happens mid-play. Compared against a pure-transport run of the
same keys, same seed, same pinned `--datetime`, byte-for-byte over the whole
24×80 terminal (`final_screen` in the bench report):

| run | engine | first frame | swap | keys after the swap | final screen |
| --- | --- | --- | --- | --- | --- |
| `--transport=worker --moves=120` | `xhr` throughout | 1324 ms | — | — | reference |
| `--transport-delay=1500 --moves=120` | `replay` → `xhr` | 1679 ms | at key 2 | 121 | **byte-equal** |
| `--transport=worker --moves=200` | `xhr` throughout | 1244 ms | — | — | reference |
| `--transport-delay=3000 --moves=200` | `replay` → `xhr` | 1820 ms | at key 8 | 199 | **byte-equal** |

Both upgraded runs: 0 console output, all keys consumed, `gameover: false`.

Scoring and the Node path are unaffected:

| what | result |
| --- | --- |
| `tools/judge-sim/run.mjs seed8000-tourist-starter.session.json` | PASS, 0 mismatches, 0 out-of-scope |
| `tools/judge-sim/run.mjs seed0013-friday13-save-then-fullmoon-restore.session.json` | PASS (multi-segment) |
| `frozen/ps_test_runner.mjs` on seed8000 + seed4500 | 2/2 PASS, RNG 111405/111405, screens 1837/1837 |
| `frozen/playability_runner.mjs` seed8000 | runs, 22 moves, 42.1 ms/move (Node path untouched) |
| `tools/strict-score.mjs --all` | 0 static violations, 44/44 sandbox parity |

### judge-sim switches

- `--transport=worker|sharedworker|sab|replay` — narrows the field to one
  transport. Honoured by `transportOverride()` in `js/boot/interactive.mjs`,
  which can only ever *remove* transports, so it cannot make a browser look more
  capable than it is.
- `--inert-sw` — serves a service worker that registers and activates normally
  and intercepts nothing. Reproduces "the probe says no" without needing a
  browser that gets worker control wrong. Fails **fast**.
- `--hang-sw` — serves a service worker that registers, activates, intercepts,
  and never answers a probe or a key request. Fails **slowly**, which is the
  whole point: this is the shape the ladder could not survive, and nothing here
  could stage it before.
- `--sw-deny-dedicated` — serves the real `js/sw.js` with its probe answer made
  conditional on `Client.type`: a dedicated worker is told "not intercepted", a
  SharedWorker is told the truth. This is the only way to stage the actual
  dedicated-fails-shared-catches handoff, since Chromium has no flag that makes
  it stop controlling dedicated workers. The patch is a string replacement
  against a known line of `js/sw.js` and **throws** if that line moves, so it
  cannot silently start testing the opposite of what it claims.
- `--judge-stub` — wraps every HTML page we serve in a host shaped like the
  judge's: a `process` stub claiming `versions.node`, and an import map aiming
  `node:*` at shims. Its `stderr` goes to `console.error` on purpose — anything
  we write there in that environment is a console line the judge would count.
- `--viewer[=a.json,b.json]` — drives `tools/judge-sim/viewer-repro.html`
  instead of the play page: ONE import of `js/jsmain.js`, several sessions
  replayed through it, which is how the Session Viewer works and is the only
  thing here that exercises "a second game in a page that already ran one".
- `--transport-delay=<ms>` — holds the transports back inside
  `js/boot/interactive.mjs` so the fallback wins the race and the upgrade swap
  can be measured on purpose. Like `--transport=`, it can only make the page
  slower.
- `--datetime=<YYYYMMDDHHMMSS>` — pins the clock NetHack starts from, so two
  runs can be compared screen-for-screen (the default is "now", which is not).

## What could not be verified, and residual risk

- **A machine slower than this one.** The race removes every *waiting* cost from
  the first frame, but not the work: ~1 s of module instantiation before either
  engine can paint. On hardware two or three times slower than this laptop,
  every number in the matrix scales with it and a 3 s budget gets tight — and
  nothing in this change helps, because both engines pay the same boot. If the
  judge still reports 0 moves after this, that is the next thing to measure.
- **A browser that actually fails the dedicated worker.** No Chromium available
  here gets dedicated-worker control "wrong", so that failure was staged with
  `--sw-deny-dedicated` (the service worker declining) rather than observed (the
  browser declining). The realm sees the same thing either way — its request
  reaching the network — but the staging is one step removed from the condition
  it stands in for.
- **Browsers other than Chrome 139.** Firefox and Safari were not exercised.
  The SharedWorker argument (matched by their own script URL) is a spec
  guarantee rather than a measured one there. Firefox and Safari both support
  classic SharedWorkers and `import()` inside classic workers.
- **A browser with no `SharedWorker`.** Guarded with `typeof SharedWorker !==
  'undefined'`; such a browser races one transport against the fallback. Not
  reproducible here — this headless Chrome has `SharedWorker`.
- **A browser old enough to lack `import()` in classic workers.** The
  SharedWorker shim needs it. Roughly the same vintage of Chromium that would
  fail the dedicated worker, so on a genuinely old build both may fail and the
  page plays on the fallback — slow, but silent and correct, and now *promptly*
  slow rather than slow after a 22-second wait.
- **Three heavy boots at once.** In the worst case the page has two engine
  realms preparing and one replay realm instantiating the 14.5 MB graph. Only
  one of those ever *boots a game* (the probe stage is a bare worker), and the
  losers are killed the moment there is a winner — but on a single-core judge
  container the overlap between the fallback boot and the transport boot is real
  contention that this machine (10 cores) does not feel. The 700 ms head start
  is what keeps that window small, and it is the first number to try moving if a
  slow environment turns out to be the problem.
- **The upgrade swap under a human's hands.** It is verified against a bench
  that types as fast as frames arrive, and by construction it can only land
  between two keystrokes. What is not verified is a swap landing in the middle
  of a multi-key prompt sequence *that the replay engine has not yet converged
  on* — the newcomer replays exactly the keys that were delivered, so it should
  be identical, and the byte-equal final screens are evidence for that, but the
  prompt-heavy case was not singled out.
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
  away. This is much better than it was: a retired realm is now told to unwind
  through its own key lane (`{type:'nhclose'}` in `js/sw.js`), and the probe it
  might be sitting on is bounded at 1 s instead of 5. Each engine still names its
  SharedWorker uniquely, so an orphan can never be reconnected to by a reload
  and mistaken for a live game.
- **A page that opens two games at once.** Not a supported shape — one game per
  page — but the lane tokens now make it survivable rather than a keystroke
  lottery.
