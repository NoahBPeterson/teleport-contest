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
>
> The race removed all the *waiting* and left the *work*, which on the judge's
> hardware is still the whole budget. [The prewarm](#the-prewarm) is what
> happened next: the half of a first frame that does not depend on the job —
> instantiating the transpiled module graph — is now paid while the page is
> loading, before anybody starts a clock.

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
- `--part2=<ms>` — runs the two-phase shape the judge's browser check uses:
  load `index.html` and leave it alone for `<ms>` (their script-error /
  failed-fetch observation window), and only then build a `NethackGame` and
  drive it. The number to read out of these runs is `start_to_frame_ms`, not
  `first_frame_ms`. See [The prewarm](#the-prewarm).
- `--seed2=<n>` — the seed that second phase asks for, which is never the one
  the page would have picked itself. Staged on purpose, because it is always
  the judge's case.
- `--no-prewarm` — passes `?prewarm=0`, so `index.html` warms nothing at page
  load. This is the floor: it is what every run looked like before the prewarm
  existed.
- `--key-delay=<ms>` — paces the bench's keystrokes instead of typing as fast
  as frames arrive. Needed once a rung got fast enough that 1200 keys take
  0.6 s, which is shorter than any transport takes to come up: without a pace
  the upgrade swap cannot be observed for reasons that have nothing to do with
  whether it works. The pause is excluded from `wall_ms`, so `ms/move` stays
  comparable with unpaced rows.
- `--cpu-throttle=<n>` — CDP `Emulation.setCPUThrottlingRate`, applied to every
  target that accepts it at attach time. Chrome's `Emulation` domain is not
  available on worker targets, so this slows the page and leaves the worker
  transports' engines at full speed; it handicaps the main-thread rung on
  purpose and must be read with that in mind.
- `--latency=<ms>` — makes the server answer every request that much later, so
  the cost of *fetching* a module graph is priced instead of assumed. Loopback
  answers in microseconds; the mirror does not.
- `--multigame[=N]` — drives `tools/judge-sim/multigame-repro.html`: N
  *interactive* games built back-to-back in one page with no reload. Nothing
  else here can stage that (`index.html` plays one game and reloads for the
  next), and it is the only check on what happens after a main-thread engine has
  spent the page realm. Asserts that game 2 is hosted by something other than
  that realm, or refuses in words.
- `--workerless` — with `--multigame`, removes `Worker` and `SharedWorker` from
  the repro page before anything imports. Staged by deleting the globals rather
  than by a CSP header, because a CSP violation is a console line and the
  console tally is part of what is being checked.

`tools/judge-sim/loadgen.mjs` is not a switch but belongs beside them: it burns
N cores for S seconds so a bench can be taken on a machine busy the way a small
container is busy. It contends for the same cores as every target in the
browser at once, which is the handicap `--cpu-throttle` cannot apply evenly.

## The prewarm

The race removed every *wait* from the first frame and left the *work*: about a
second of it, on this machine, before either engine can paint. The judge's box
is roughly 2.6x slower (their scoring fit is 2157 + 6.40·n against our 830 +
0.8·n), so 1.2 s here is ~3.1 s there, which is the whole budget — and the
crawls that followed the race said exactly that: `browser_ok: true`,
`error_class: None`, **0 moves in 88 sessions**, total_cumulative_ms 2.7–3.2 s.
No waiting left to remove. So remove the work from the clock instead.

### The free time nobody was using

Loading the page and playing the first game are two different moments:

- a **human** loads `/play/<owner>/`, reads the subtitle, and presses a key
  seconds later;
- the **judge's browser check** loads `index.html` in headless Chromium and
  watches it for script errors and failed fetches, and only *then* drives a game
  — `new NethackGame({seed, datetime, nethackrc})`, `_pendingDisplay`,
  `game.nhDisplay`, `await start()`, one `moveloop_core()` per key. That is the
  shape of `frozen/playability_runner.mjs`, and its clock starts at `t_start`,
  immediately before `start()`.

Everything in between was idle CPU, and the page threw it away: `index.html`
waited on `display.readKey()` and booted nothing until somebody asked.

### What is warmed, and why it needs no seed

A cold boot is two costs in a fixed order (measured in Node, and the browser
agrees within noise):

| | cost | depends on |
| --- | --- | --- |
| instantiate `js/generated/**` (176 modules, 13 MB) | ~480 ms | **nothing** |
| `runBootGame` → `main()` → newgame, to the first `getchar()` park | ~550 ms | seed, datetime, nethackrc |

Only the second half needs a job. So `prewarmEngine()` (js/boot/interactive.mjs),
called from a classic `<script>` at the top of `index.html`'s `<head>` — before
the page's own module script, before its `snapshot.json` fetch — brings up a
transport the ordinary way and then posts `{type:'warm'}` to the realm that won
it. The worker imports `harness.mjs` and `../generated/unixmain.js` and stops
there (`warmRealm()` in js/boot/engine-worker.mjs). It has run no C code. Every
C file-scope variable is at its static initialiser.

**That realm is therefore pristine, and it fits any job.** There is no
fingerprint, no seed to match, and no such thing as a prewarm for the wrong
seed — which matters, because the page cannot know the judge's seed at load
time and never will. Whoever calls `startEngine()` first adopts the realm,
whatever they ask for.

Importing the graph outside `runBootGame()` is safe because no generated module
reads a harness global at module scope: the graph imports cleanly on its own
with none of `runBootGame()`'s shims installed. `runBootGame()`'s own
`await import('../generated/unixmain.js')` then resolves from the module map, to
the same namespace object, and the graph is still instantiated exactly once per
realm.

### The adopt/discard contract

- **Claimed at most once.** `claimPrewarm()` empties the slot before it awaits,
  so two games can never be handed the same realm.
- **Claiming never waits for the warm.** The prewarm promise resolves when the
  realm is *prepared* (spawned, ready, probe passed), not when it is warm; the
  warm-up is left running. A claim that arrives early therefore *joins* the
  import already in flight — `_boot()`'s own import is the same module job — and
  a claim that arrives late finds it done. Waiting would have turned the prewarm
  into a delay on exactly the pages it exists to help, and did, in the first
  version of this: the self-driven bench went 1293 → 1514 ms until the claim was
  made non-blocking.
- **Realm discipline.** The warm realm is a worker of its own, so adopting it
  cannot mark the *page* realm spent (`js/jsmain.js`'s `__c2jsEngineRealmUsed`)
  and cannot interact with `runSegment()`. Nothing on the scoring path can see
  it: `runSegment` never calls `startEngine`.
- **Discarding is `retire()`** — worker terminated, service-worker lane closed
  with `{type:'nhclose'}`. The only paths that discard are a prewarm whose
  transports failed (nothing was left running to discard) and a page that goes
  away.
- **Nothing is ever said.** `prewarmEngine()` returns void and its promise
  cannot reject: every failure — no service worker, a service worker that
  hangs, a browser with no workers, `?transport=replay` — ends as a resolved
  `null`, with handlers attached before anything can settle. A prewarm has
  nobody to report to, and a console line would fail the run on its own.
- **A failed prewarm is evidence, and the race is not re-run.** A prewarm that
  came to nothing has already run this exact race at page load and lost it, and
  the answer cannot have changed: the service-worker registration is memoised
  (below), a realm that never said `ready` has no workers, and a realm the
  service worker declined to intercept is a property of the browser rather than
  of a moment. So `RacedEngine.start()` fails the transport immediately, which
  releases the ReplayEngine's head start at once and puts the degradation banner
  up with the prewarm's own reason. Re-running it was measurably worse: two more
  realms spawning and probing while the replay fallback wants the CPU cost
  `--hang-sw` about 200 ms of first frame for an answer that was already known.
  (`js/sw.js` calls `skipWaiting()` and `clients.claim()`, so there is no
  first-visit window where the answer would legitimately change between the two
  attempts.)
- **`ensureKeyService()` is memoised, null included.** The prewarm asks at page
  load and `startEngine()` would ask again, and
  `navigator.serviceWorker.register()` is not free to ask twice: on a mirror
  that failed to publish `js/sw.js` the *browser* logs a 404 line we cannot
  catch. Two calls would have been two console lines where there was one. The
  null answer is memoised deliberately — service workers disabled, a
  private-mode profile, `js/sw.js` unpublished — none of those heal inside one
  page's lifetime, and asking again costs a console line to learn the same
  thing.

### Only the winner is warmed, and only after it has proved it can block

The first version warmed the preferred realm *during* the race, to overlap the
import with the service-worker round trip. That was a mistake and the bench
said so: in `--hang-sw` the dedicated realm spent its whole 1 s probe timeout
instantiating a 13 MB graph, against a replay fallback that was about to need
the CPU, and the first frame went 1970 → 2237 ms.

So `warm` is posted only to the realm that won `firstReadyTransport()` — after
`ready`, after the probe, after it has proved it can block. A realm nobody will
play in never pays for a graph, and the SharedWorker (which has no
`terminate()`, so an abandoned one would go on burning a core until it finished
a graph nobody wants) is only ever warmed when it is the one that won.

The overlap that was given up is worth almost nothing on a healthy host: the
probe is one same-origin request the service worker answers from memory.

### index.html still waits for a key

**Not any more, and that was the bug.** This section said:

> Deliberately. The prewarm is job-independent and adoptable; a *game* is not.
> If `index.html` booted its own game at load, a driver that then built its own
> `NethackGame` would find `startEngine()` retiring a game it never asked for
> and paying for a second boot — the double-boot hazard. The `readKey()` gate is
> what keeps the page from starting a game nobody asked for, and the prewarm is
> what makes that gate free.

Every sentence of that is about a driver that *types*. It is silent about a
driver that **waits for a frame before it types**, and against that shape a page
gated on `readKey()` does not merely fail to help — it deadlocks: no key, no
game, no frame, no key. See [A game the page starts, and a driver can take
away](#a-game-the-page-starts-and-a-driver-can-take-away). The double-boot
hazard is real and is still the thing the design has to answer; it is answered
by making the page's game a *claim* a driver takes, rather than by not having
one.

### The first-frame diet: what was taken, what was not

Profiled with `--cpu-prof` on the Node boot path, which is the only place the
two halves can be separated cleanly (`node --cpu-prof -e "import graph; then
runBootGame(..., waitForKey: () => -1)"`):

```
    23 ms   process start
     1 ms   js/boot/browser-env.mjs
    18 ms   js/boot/harness.mjs  (incl. data-nethackdir + posix-ere)
     2 ms   js/cptr.js
   477 ms   js/generated/unixmain.js — the whole graph
   555 ms   newgame, to the first getchar() park
```

and inside that 555 ms: `js/cptr.js` 297 ms spread over everything,
`options.js:determine_ambiguities` 35 ms, the Lua interpreter parsing NetHack's
`.lua` data files (`nhlua`/`llex`/`lparser`/`lcode`/`ldo`/`lstring`) ~90 ms,
`glyphs.js` 20 ms, `display.js` 13 ms, `mklev.js` 9 ms.

**Taken:**

1. **Move the 477 ms graph off the clock entirely** (the prewarm above). This is
   the item that was written down as "defer nhconst/nhmacro/rarely-reached
   generated modules via dynamic import after the first park", and it turned out
   there was a better answer to the same question: the graph does not have to be
   made smaller if it can be instantiated before anyone is timing.
2. **Warm the realm in parallel with the interception probe** rather than after
   it — the `warm` message is posted immediately behind the probe on the same
   queue, so the ~500 ms import overlaps the service-worker round trip and the
   page's own module loading instead of following them.
3. **`<link rel="modulepreload">` for the page's hot chain** (`interactive.mjs`,
   `engine-worker.mjs`, `browser-env.mjs`, `jsmain.js`, `isolation.mjs`,
   `game_display.js`, `terminal.js`, `frozen/screen-decode.mjs`, `gstate.js`,
   `allmain.js`, `storage.js`). Not measurable on the judge-sim server, which is
   loopback with no latency; it is worth one round trip each on the real mirror,
   where the chain is otherwise discovered one import at a time. Every file
   listed is published under `js/**` or `frozen/**`, so none of them can 404 —
   a 404 here would be a console line, which is the failure this whole document
   is about. Checked: Chrome logs nothing for the two that the *page* realm
   never imports (`engine-worker.mjs` is imported by the worker, not the page).

**Not taken, and why:**

- **Splitting the static graph.** `js/generated/**` is one statically-imported
  component: `unixmain.js` reaches everything, and the emitter writes those
  imports. Cutting `nhconst`/`nhmacro`/cold modules out of the eager graph and
  behind `import()` would need `tools/c2js` to emit different module boundaries
  and to know which symbols are reachable before the first `getchar()` — a
  reachability analysis over the whole corpus, owned by the emitter effort, not
  by this one. **It is also now worth much less than it was**: the graph is no
  longer on the first frame's critical path at all, so the prize for halving it
  is halving a cost the page already pays for free. Design recorded here; not
  attempted.
- **Deferring work inside newgame.** Everything expensive in the 555 ms is
  transpiled C running under `main()` — option parsing, the Lua data files, the
  level maker. There is no seam that does not change what the C does, and
  parity is the gate that outranks speed. `determine_ambiguities` (35 ms) and
  the Lua parse (~90 ms) are genuinely job-independent and would be the two
  candidates if the seam existed; it does not, in JS, without moving the split
  into the emitter.
- **Warming a second realm speculatively with a guessed seed.** A full
  speculative boot would make the adopt path ~0 ms instead of ~420 ms, but only
  when the seed matches, and the judge's never does. Two realms booting at once
  is also precisely the contention that the fallback's head start exists to
  avoid, on a container with fewer cores than this laptop.
- **Re-arming the prewarm after each game.** A driver that plays many games in
  one page — the judge's session loop — would get a realm warmed during the
  previous game and save the graph on every session after the first. It is four
  lines. It is not here because no bench in this repo plays two *interactive*
  games in one page, so it would be an unmeasured change, and the cost of
  getting it wrong is a spare 13 MB realm on the machine of every human who only
  ever plays one game per page load. Worth doing next, behind a bench that can
  see it.

### Verified

All runs: Chrome 139 headless (`--headless=new`), macOS, `judge-sim` mirror
server, a fresh Chrome profile per run, 63 keys (`--moves=60`), medians of 3.

Two clocks, because the prewarm moves work between them:

- **first frame** — navigation start to the first painted frame. The right
  clock for a page that boots itself. In `?bench=` mode the page answers its own
  "press any key" prompt at `t=0`, so this is a *synthetic worst case* for the
  prewarm: `start()` is called before the warm-up can possibly have finished.
- **start → frame** — `t_start` to the first painted frame, where `t_start` is
  taken immediately before `nhGame.start()`. This is the clock
  `frozen/playability_runner.mjs` keeps, and therefore the clock the judge's
  `total_cumulative_ms` is made of.

| mode | first frame, before → after | start → frame | engine | CDP console |
| --- | --- | --- | --- | --- |
| production shape | 1493 → **1448** | 674 | `xhr` | 0 |
| `--coi` | 1496 → **1480** | 666 | `sab` | 0 |
| `--transport=sharedworker` | 1529 → **1473** | 672 | `xhr-shared` | 0 |
| `--sw-deny-dedicated` | 1530 → **1458** | 698 | `xhr-shared` | 0 |
| `--inert-sw` | 1494 → **1476** | 684 | `replay` | 0 |
| `--no-sw` | 1522 → **1449** | 680 | `replay` | **1** (unchanged) |
| `--hang-sw` | 1970 → **2199** | 1397 | `replay` | 0 |
| `--judge-stub` | 1296 → **1484** | 726 | `xhr` | 0 |
| `--no-prewarm` (the floor, prewarm off) | **1527** | 700 | `xhr` | 0 |

Every run consumed all 63 keys with `gameover: false`, 0 out-of-scope requests,
and a status line showing a real character in the dungeon. The one console line
is `--no-sw`'s browser-emitted 404 on the service-worker script, which is
documented below and is *still one line* — that is what memoising
`ensureKeyService()` is for.

Nothing moves much in this table, and nothing should: in the `?bench=` shape the
key arrives at `t=0`, so the prewarm never gets a window to work in and the
total work is identical, only reordered. Two rows to read carefully:

- **`--judge-stub` 1296 → 1484** is noise, not a change. The individual runs
  were 1289/1296/1871 before and 1330/1484/1663 after — same spread, same mean
  (1485 vs 1492), and the medians land on opposite sides of it.
- **`--hang-sw` 1970 → 2199 is a real +229 ms, and it is the one regression.**
  On the clock the judge keeps it is not one at all: `start → frame` is 1397 ms
  with the prewarm and 1392/1399 ms with `--no-prewarm`, i.e. identical. What
  moved is *when the page got round to calling `start()`* — the prewarm's doomed
  transport attempt (service-worker registration, two realms, a 1 s probe that
  never comes back) runs concurrently with the page's own module loading and
  delays it by ~180 ms, and its failure — which is what releases the replay
  fallback — lands ~130 ms later than the old fixed 700 ms head start would
  have. The fix, not taken here, is to scale `FALLBACK_HEAD_START_MS` by how
  long the prewarm has already been trying, so a transport that has had its lead
  at page load does not get a second one; it is a change to the healthy path to
  buy a staged one, and `--hang-sw` at 2.2 s local is ~5.7 s on the judge's
  hardware either way, so it does not decide anything.

### The two-phase shape, which is the one that matters

`--part2=2000` loads `index.html`, leaves it completely alone for two seconds —
the judge's script-error / failed-fetch observation window — and only then
builds a `NethackGame` and drives it, exactly as `frozen/playability_runner.mjs`
does. `--seed2=` gives that second phase a seed the page never picked, which is
always the judge's case.

| | start → frame | prewarm | on the judge's ~2.6x hardware |
| --- | --- | --- | --- |
| `--part2=2000` | **441 ms** | adopted, warm | ≈ 1.15 s |
| `--part2=2000 --seed2=4500` (**mismatched seed**) | **451 ms** | adopted, warm | ≈ 1.17 s |
| `--part2=2000 --judge-stub` | **419 ms** | adopted, warm | ≈ 1.09 s |
| `--part2=2000 --no-prewarm` (the floor) | 715 ms | none | ≈ 1.86 s |
| `--part2=2000 --hang-sw` | 769 ms | failed | ≈ 2.0 s (`replay`) |

**441 vs 451 ms is the whole argument for a job-independent prewarm.** A seed
the page has never heard of costs the same as the one it would have guessed,
because the warm realm has run no game and there is nothing to guess. There is
no discard path to measure: the only way to get less than an adopt is to have no
prewarm at all, which is the 715 ms floor row.

### Adopt correctness

Same 87 keys, same pinned `--datetime`, compared byte-for-byte over the whole
24×80 terminal (`final_screen`):

| A (adopted a prewarmed realm) | B (cold boot, no prewarm) | screens |
| --- | --- | --- |
| `--part2=2000 --seed2=4500` | `--no-prewarm --seed=4500` | **byte-equal** |
| `--part2=2000` (seed 8000) | `--no-prewarm --seed=8000` | **byte-equal** |

Both pairs: 87 keys consumed, 0 console output, `xhr` transport, `gameover:
false`.

### Scoring and the Node path

| what | result |
| --- | --- |
| `tools/judge-sim/run.mjs seed8000-tourist-starter.session.json` | PASS, 0 mismatches, 0 out-of-scope |
| `tools/judge-sim/run.mjs seed0013-friday13-save-then-fullmoon-restore.session.json` | PASS (multi-segment) |
| `frozen/ps_test_runner.mjs` on seed8000 + seed4500 | 2/2 byte-exact |
| `frozen/playability_runner.mjs` seed8000 | unchanged — Node never prewarms (`prewarmEngine()` returns immediately when `IS_NODE`) |
| `tools/strict-score.mjs --all` | 0 static violations, 44/44 sandbox parity |
| `playability.mjs --viewer --judge-stub` | 3/3 sessions, 0 console |

`runSegment()` cannot see any of this: it never calls `startEngine()`, the warm
realm is a worker of its own, and `prewarmEngine()` is a no-op outside a
browser.

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
- **A driver that plays many games in one page.** The prewarm is armed once, at
  page load, and deliberately not re-armed after a game starts. The judge's
  session loop — if it really does drive 88 sessions through one page — therefore
  gets the warm realm for the first game and pays the full ~715 ms for every one
  after it. Re-arming is four lines and would make every session after the first
  cost ~441 ms instead, but nothing in this repo plays two *interactive* games
  in one page, so it would be an unmeasured change, and the failure mode of
  getting it wrong is a spare 13 MB realm on the machine of every human who
  plays one game per page load. The bench comes first.
- **A prewarm nobody claims.** A page that is loaded and never played holds one
  parked engine realm — a worker with the module graph instantiated in it —
  until the page goes away. That is the deliberate cost of the whole idea, and
  it is the same realm the page would have built the moment somebody pressed a
  key. It has run no C code, so it can never be *wrong*; it can only be unused.
- **A judge whose part-one window is shorter than the warm-up.** The two-phase
  numbers assume ~2 s between page load and the first `start()`. The warm-up
  finishes at roughly 700–900 ms here (service-worker registration, worker
  spawn, probe, then ~500 ms of graph), so a window narrower than that yields a
  partial win rather than none — a claim that lands early *joins* the import in
  flight instead of waiting for it, so the curve between "no prewarm" and "fully
  warm" is smooth and monotonic. It was measured at both ends (0 ms: the
  `?bench=` rows; 2000 ms: the two-phase table) and not in between.
- **`--hang-sw` costs ~230 ms of first frame that it did not before.** Detailed
  under [Verified](#verified): on the clock the judge keeps it is unchanged, and
  the mode is over budget on their hardware in both versions.
- **A page that opens two games at once.** Not a supported shape — one game per
  page — but the lane tokens now make it survivable rather than a keystroke
  lottery.

## A game the page starts, and a driver can take away

The race removed the waiting. The prewarm removed the work. Six judge crawls
later the answer was still `browser_ok: true`, `error_class: None`, **0 moves**,
2.7–3.3 s — which is what a page that never started looks like from outside, and
which no amount of making the boot faster was ever going to change, because
nothing in this tree ran until somebody asked for a game.

`index.html` painted *"Click here and press any key."* and booted on the first
keystroke. Consider the ordinary shape of a browser test harness:

```
load the page
wait for the app to be ready          <- a frame, a selector, a global
send input
assert
```

Against this page, step 2 never completes. The page is waiting to be typed at;
the harness is waiting to be shown something. Neither moves, and at the timeout
the harness reports a page that loaded cleanly, threw nothing, logged nothing
and played nothing. That is the crawl result, exactly, six times.

So the page boots a real game at load.

### Three driver shapes, and what each one needs

| | shape | what it does | what it needs from us |
| --- | --- | --- | --- |
| **A** | a human | loads `/play/<owner>/`, then types, seconds later | a game already running when they look at it, and no instruction to obey first |
| **B** | a **page-driving** harness | loads `index.html`, waits for a frame, then dispatches keydowns at the document | a frame with **nothing typed**, then the ordinary keyboard path |
| **C** | a **constructing** harness | imports `js/jsmain.js`, builds its own `NethackGame({seed, …})`, drives `moveloop_core()` — `frozen/playability_runner.mjs`, and the judge's browser check | its own game, on its own seed, with the page's game gone and not competing |
| **D** | the scorer | `runSegment()` in Node, or the Session Viewer | nothing to change, and nothing to notice |

A and B want the page to start a game. C wants it not to have. The page cannot
tell which one it is talking to, and it never will — so it starts one, and hands
it over when asked.

### The claim

`js/boot/interactive.mjs`, "The auto-boot claim".

- **`armAutoBoot()` is called at parse time**, from the same `<script>` in
  `<head>` that starts the prewarm, ahead of the page's own module script.
- **`startEngine(job, onDegraded, { auto: true })`** is the page's game. There is
  exactly one caller — `index.html`, through `new NethackGame({ autoBoot: true })`.
- **`startEngine(job, onDegraded)` with no `auto`** is, by definition, somebody
  else's. It calls `preemptAutoBoot()` *first*: the flag goes up synchronously,
  ahead of that function's own first await, and then the page's teardown is
  awaited before the driver's race begins.
- **The page's game re-checks the flag at every await boundary in front of an
  irreversible step.** This is the leg-2 cancellation pattern (see
  `docs/NOTES-async-engine.md`, "the phantom boot"): a rung whose cancellation is
  free and a rung whose cancellation is impossible cannot share one check at the
  end. There are three:

  | # | where | what is still reversible |
  | --- | --- | --- |
  | 1 | entering the race, before the prewarm is claimed | everything |
  | 2 | after the transport is prepared, **before `_boot()`** | the realm — it has run no C code and still fits any job |
  | 3 | after `start()` resolves | nothing; the game is torn down instead |

### Handing the warm realm back

The page's game claims the prewarm *provisionally*. Between the claim and
`_boot()` nothing has happened to the realm, so `preemptAutoBoot()` puts it
straight back on the shelf — synchronously, before its own first await, so that
the `claimPrewarm()` the driver is about to make finds it there. A driver that
gets in early therefore costs the page nothing at all: it adopts the same warm
realm the page was going to, and the page never existed as far as the engine is
concerned.

One ordering here took two attempts and is worth stating, because it is the kind
of bug that only appears when two consumers await the same promise. The page's
game is suspended inside its own `claimPrewarm()`, on `await slot.p`. The driver
preempts, the slot goes back, the driver claims it and suspends on the *same*
`slot.p`. When it resolves, **the page's game wakes first** — it awaited first —
finds the shelf empty again, and, on the obvious reading of "empty", retires the
realm out from under the driver that is about to boot in it. The slot therefore
carries a sticky `returned` flag, which is how "empty because it was never given
back" is told from "empty because somebody has already taken what I gave back".

### The grace is a check, not a timer

The brief asked for roughly 300 ms of grace. What is implemented is not a
window: it is a claim check in front of each irreversible step, which is
strictly better where it applies and honestly narrower than 300 ms where it does
not. The page's game becomes irreversible at check 2 — the moment its transport
is prepared — and locally that is **~70 ms after the claim**, because the
service-worker handshake is fast on loopback. Measured, `--part2=<ms>`:

| a driver that claims at | page's game | driver's `start → frame` | adopted a warm realm? |
| --- | --- | --- | --- |
| 30 ms | never booted | **568 ms** | yes |
| 60 / 100 / 150 / 300 ms | never booted | 601–626 ms | no — cold |
| 700 ms | booted, 616 ms | 433 ms | yes (the re-arm), not yet warm |
| 2000 ms (**the judge's shape**) | booted, 611 ms | **344 ms** | yes, warm |

The band from ~70 ms to the page's first frame is the honest cost: a driver that
claims there pays a cold boot, ~600 ms against ~345 ms. It is not the judge's
shape — their part-one window is a script-error observation period measured in
seconds, not tens of milliseconds — and it is the same ~600 ms the page cost
every driver before the prewarm existed at all.

### The prewarm, re-armed

The prewarm used to be armed exactly once, and the reason was that there was
nothing to arm it for: the page waited for a key, so the first game to ask was
the only game there would ever be. A page that boots its own game has spent that
realm before any driver can ask — and shape C is precisely the driver that used
to collect it.

So `startEngine()` re-arms, once, **behind the page's own game**, after its first
frame has painted. Not before: the first frame is the budget, and a second realm
spawning and instantiating 13 MB beside it is exactly the contention
`FALLBACK_HEAD_START_MS` exists to avoid. The measured effect is the 2000 ms row
above — 344 ms, against the 591 ms a cold constructed run costs and the 357–391 ms
the page managed when it booted nothing at all.

The cost is the one recorded under "What could not be verified" as the reason not
to do this: one spare worker realm, holding an instantiated module graph, on the
machine of a human who is only ever going to play the game the page already
started for them. That is now a much better trade than it was, because the realm
is no longer speculative — the shape it serves is the shape that was failing us.

`?prewarm=0` is honoured inside `prewarmEngine()` rather than only at
`index.html`'s call site, because "no prewarm" has to mean *neither* arming.

### Which rung the page's game may use

A game the page started on its own account has a constraint no other game has:
it must be able to disappear. The two fallback rungs are not equally able to.

- **A ReplayEngine lives in a worker realm.** Retiring it is a `terminate()`; the
  page realm is untouched.
- **A MainThreadEngine spends the page realm.** 13.6 MB instantiated in it,
  transpiled C run in it, `claimed` set, `__c2jsEngineRealmUsed` set — none of
  which can be given back, and all of which is the one rung a workerless browser
  has.

So the page's game takes a **worker rung whenever there is one**, and reaches the
main-thread rung only when `workerRungAvailable()` says there is no worker realm
to be had. `?transport=main` still forces it, because a bench that asks for one
rung must get that rung. Its ReplayEngine is additionally built with
`{ noPageRealm: true }`, which refuses `_boot()`'s last-resort in-page import
rather than taking it — so "no worker realm after all" falls through to the
main-thread rung, which is the right answer once nothing else exists, instead of
quietly spending the realm on the *sync* graph.

**This costs the degraded modes their fast rung, and the number is not small.**
`--inert-sw`, `--no-sw` and `--hang-sw` used to land the page on `main` at
~0.66 ms/move; the page's own game now lands on `replay` at ~20 ms/move there,
and gets the degradation banner with it. What is bought is that a constructing
driver arriving on such a page finds the main-thread rung *unspent* and gets
0.66 ms/move itself — and the driver is the one whose ms/move is scored
(`frozen/playability_runner.mjs` fails above 1.0 ms/move). The trade is
deliberate: the page's game is the one we can afford to run slowly, because the
page's game is not the one being judged. On a correctly published mirror none of
this is reachable — `js/sw.js` ships, the transports work, and the fallback slot
never runs at all.

### The workerless corner, precisely

Stated in full because it is the one place two of these rules meet:

1. A page with **no `Worker` constructor at all** has no worker rung. The page's
   game therefore takes the main-thread rung and spends the page realm.
2. A constructing driver on that page finds `claimed` set, so the main-thread
   rung refuses; `ReplayEngine` cannot make a worker realm either; and its
   in-page last resort finds `__c2jsEngineRealmUsed` and refuses **in words**:

   > this page realm has already run a game and cannot host another: no Worker to
   > make a fresh realm in, and no module-map isolation. Reload the page to play
   > again.

   That is the documented spent-realm contract, reached with nothing on the
   console.
3. If workers are available to the driver but were not to the page — which
   cannot happen in one page's lifetime, since `workerRungAvailable()` reads the
   same globals — the driver would get a ReplayEngine realm instead, and no
   error. This is the shape `--multigame --workerless` stages from the other
   direction: game 1 on `main`, games 2 and 3 refusing in words.
4. Conversely, a page that **does** have workers never spends its realm on the
   page's game, so a driver there always finds the main-thread rung available.
   Verified with `--part2=2000 --transport=main`, which forces the page onto
   `main` anyway: the driver is preempted onto a `replay` worker realm, plays all
   its keys, and says nothing.

### Teardown rules

`onAutoBootTeardown()` is registered by `index.html` **before** it boots
anything, because a driver may preempt while `start()` is still running and the
teardown is what `preemptAutoBoot()` awaits. In order:

1. **The keyboard listener comes off first.** `new GameDisplay(...)` installs a
   `keydown` handler on `document`, and a driver builds its own display; two
   live terminals would race for every keystroke. The page's is uninstalled the
   moment the page stops owning the keyboard.
2. **The engine is stopped and destroyed** — worker terminated, service-worker
   key lane closed with `{type:'nhclose'}`, replay realm aborted mid-boot. All of
   that is `RacedEngine.destroy()`, which now also **rejects a `start()` that has
   not settled**. Retiring an engine mid-race used to leave its caller awaiting a
   promise nothing would ever resolve; it only became reachable when the page
   grew a game that can be taken away from it, but it was always wrong.
3. **The key pump is cancelled, and the teardown waits for it to have stopped.**
   This is the subtle one. `moveloop_core()` reads `game.nhDisplay`,
   `game.nhEngine` and `game.program_state` out of the module-global `game` —
   the three fields the driver's `start()` is about to replace. A pump that took
   one more turn afterwards would be driving the driver's game; a
   `moveloop_core` that merely *finished* afterwards would write its own
   `gameover` into the driver's `program_state` and end that game before it
   began. The pump therefore races `moveloop_core()` against an explicit
   cancellation promise rather than relying on the engine to unblock it, and the
   abandoned `readKey()` is left parked on a terminal that has neither a keyboard
   listener nor a DOM node.

   The first version waited on the pump with a 500 ms bound instead. It was
   correct and it cost 500 ms of the driver's `start → frame` — 868 ms against
   351 ms — which is the sort of thing that only shows up if the clock the judge
   keeps is the clock being measured.
4. **A preempted transport does not release the fallback.** A transport that
   *failed* means the fallback is the page's only hope and should stop waiting; a
   transport that was *taken away* means the whole game is unwanted, so the
   fallback is destroyed before its head start is released and the race ends
   there. Otherwise a page whose game had just been preempted would go and boot a
   replay realm for it.

Nothing above says anything, in either direction. `AutoBootPreempted` is thrown,
caught by `index.html`, and dropped; it is the one error the page's fatal handler
is deaf to.

### `?part2=` is now the shape it always stood for

It used to mean "sit still for `<ms>`, then build a game" — a stand-in for a
driver, on a page that was doing nothing. It now means what it says: the page
boots and plays its own game, is left alone for `<ms>`, and is then preempted by
a `NethackGame` built from scratch with a seed it never picked. That is shape C
end to end, inside one page, which is the only place it can be measured.

`?autoboot=0` restores the old wait-for-a-key page. It is the control for every
number in this section and the way shape B's failure is staged.

## The pre-start diet

Leg 2 measured ~700–800 ms from navigation to `NethackGame.start()` being
*entered* — before any engine work at all. It is now **~40 ms**. Three cuts, one
of which is almost all of it.

### The web font was blocking the engine

`index.html` loaded EB Garamond from `fonts.googleapis.com` with an ordinary
`<link rel="stylesheet">`, above everything else in `<head>`. A script — classic
or module, inline or external — does not execute until every stylesheet ahead of
it has loaded. So the prewarm, the auto-boot claim and the `snapshot.json` fetch
all sat behind a round trip to somebody else's server, on a page whose entire
budget is about three seconds.

Measured, production mode, same machine:

| | module script starts | nav → `start()` entry | nav → first frame |
| --- | --- | --- | --- |
| blocking `<link rel="stylesheet">` | **579 ms** | 598 ms | 958 ms |
| `media="print" onload="this.media='all'"` | **23 ms** | **51 ms** | **666 ms** |

`media="print"` takes the sheet out of the set the document is blocked on; the
`onload` flips it back to `all` when it arrives, at which point it applies
normally. The font is still fetched at the same moment, and a `<noscript>` copy
keeps it for a reader with scripting off, who has no game to wait for. The
`modulepreload` chain moved above it for the same reason.

### `snapshot.json` was in front of the module graph

The module script opened with `await fetch('./snapshot.json')` and only then
started its five dynamic imports, because `js/storage.js` reads the fork's VFS
prefix at module top level and the prefix comes out of the snapshot. Correct,
and a full round trip in front of the module graph for the sake of a string.

The fetch now starts in `<head>` at parse time, beside the prewarm; the imports
start on the module script's first line; and the snapshot is awaited exactly
where it is needed — immediately before the game's storage handle is built, by
which time it has long since arrived (`snapshot_ms` ~45 ms, `start_entry_ms`
~51 ms).

### Two things left the critical path entirely

- **`js/storage.js`** is imported lazily, from `showGameOver()`, which is the only
  thing that uses it. That also makes its top-level prefix capture
  unconditionally correct rather than correct-by-ordering.
- **The subtitle rewrite** (naming the fork and linking its GitHub) happens after
  the first frame. It is a string in a paragraph.

### Where the 51 ms goes now

`start_entry_ms` and friends are in every `?bench=` report. Production, medians:

```
 21 ms  <head> script runs: snapshot fetch out, prewarm and auto-boot armed
 23 ms  the page's module script begins
 47 ms  its five imports have resolved (all modulepreloaded)
 51 ms  snapshot in hand, storage built, NethackGame.start() entered
666 ms  first frame
```

There is nothing left worth cutting in front of `start()`: the remaining
~615 ms is the engine — service-worker registration, worker spawn, interception
probe, and `newgame()`.

## Verified: the auto-boot leg

All runs: Chrome 141 headless (`--headless=new`), macOS, `judge-sim` mirror
server, fresh Chrome profile per run, seed 8000, 243 keys, pinned
`--datetime=20240101120000`, from the repo root. **After** is the median of
three rounds; **before** is one round of the same command against the page and
engine at `25964de`, taken in the same sitting with the same harness.

`first frame` is navigation start to the first painted frame. The two columns do
not mean the same thing and that is the point of the leg: **before**, it is the
frame the bench got by answering the page's own "press any key" prompt at
`t=0` — a frame no driver that waits could ever have seen. **After**, it is the
frame the page paints with nothing pressed at all.

| mode | engine, before → after | first frame, before → after | start → frame | ms/move, before → after | keys before first frame | CDP console |
| --- | --- | --- | --- | --- | --- | --- |
| production | `xhr` → `xhr` | 1532 → **641** | 591 | 2.03 → 2.24 | 0 | 0 |
| `--coi` | `sab` → `sab` | 1204 → **619** | 573 | 0.98 → 1.11 | 0 | 0 |
| `--transport=sharedworker` | `xhr-shared` → `xhr-shared` | 1424 → **619** | 581 | 2.10 → 2.05 | 0 | 0 |
| `--sw-deny-dedicated` | `xhr-shared` → `xhr-shared` | 1291 → **613** | 576 | 2.04 → 2.15 | 0 | 0 |
| `--inert-sw` | `main` → **`replay`** | 1367 → **634** | 594 | 0.63 → **19.60** | 0 | 0 |
| `--no-sw` | `main` → **`replay`** | 1130 → **636** | 588 | 0.67 → **19.60** | 0 | **1** † |
| `--hang-sw` | `main` → **`replay`** | 2167 → **1340** | 1304 | 0.64 → **19.85** | 0 | 0 |
| `--judge-stub` | `xhr` → `xhr` | 1171 → **652** | 605 | 2.00 → 3.48 | 0 | 0 |
| `--transport=main` | `main` → `main` | 1349 → **603** | 562 | 0.64 → 0.78 | 0 | 0 |

Every row: 243 keys consumed, `gameover: false`, 0 out-of-scope requests, and a
status line showing a real character in the dungeon. Target was < 1.2 s cold in
every healthy mode and < 2.3 s in `--hang-sw`; the worst healthy row is 652 ms
and `--hang-sw` is 1340 ms.

† `--no-sw`'s single line is the browser's own uncatchable *"A bad HTTP response
code (404) was received when fetching the script"* against a mirror with no
`js/sw.js`. Pre-existing, present in the **before** column too, unreachable on a
correctly published mirror.

**The three `replay` rows are the cost of the worker-rung rule**, not a
regression in the rung: `--transport=main` still measures 0.78 ms/move, and a
constructing driver on any of those pages gets that rung rather than this one.
See [Which rung the page's game may
use](#which-rung-the-pages-game-may-use).

The `--judge-stub` ms/move (2.00 → 3.48) is spread, not signal: the three rounds
were 2.10 / 3.48 / 4.00, and the transport rows in this file have always had a
worst round several times their best (`docs/NOTES-async-engine.md`, "The spread
is the most interesting column").

### Shape B — a page-driving harness, from outside the page

`playability.mjs --shape-b`. Navigate over CDP; poll for a frame **sending
nothing**; then send keys as real keydowns with `Input.dispatchKeyEvent`. Three
rounds, 63 keys:

| | frame with nothing typed | keys before it | keys consumed | ms/move (incl. one CDP round trip each) | engine ms/move | console |
| --- | --- | --- | --- | --- | --- | --- |
| this tree | **649 / 664 / 647 ms** (`xhr`) | **0** | 63 / 63 / 63 | 8.51 / 8.52 / 8.37 | 1.19 / 1.18 / 1.16 | 0 |
| `--no-autoboot` (the page at `25964de`) | **never** | — | **0** | — | — | 0 |

The second row is the crawl result, reproduced on demand for the first time:

```
=== Page-driving harness (frame first, then keys, all from outside) ===
  frame with nothing typed : NONE ms
  keys consumed after it   : 0
  FAIL: no game frame ever painted, and nothing was typed —
        this is the deadlock --shape-b exists to catch
```

`ms/move` there is an upper bound and is labelled that way in the tool: the
driver is on the far side of a WebSocket and pays a round trip per key. The
engine-thread figure beside it is the clean one, and it agrees with the
production row above.

### Shape C — a constructing driver preempts the page's game

`playability.mjs --part2=2000 --seed2=4500 --moves=87`, three rounds. The page
boots and plays its own game on seed 8000; two seconds later a `NethackGame` on
seed 4500 is built from scratch and takes over.

| | page's game | driver's `start → frame` | prewarm | keys | console |
| --- | --- | --- | --- | --- | --- |
| round 1 | painted 746 ms, `xhr` | 380 ms | adopted, warm | 93 | 0 |
| round 2 | painted 682 ms, `xhr` | 356 ms | adopted, warm | 93 | 0 |
| round 3 | painted 661 ms, `xhr` | 354 ms | adopted, warm | 93 | 0 |
| `--no-autoboot --part2=2000` (page idle throughout) | — | 353 ms | adopted, warm | 93 | 0 |
| `--no-autoboot --no-prewarm --seed=4500` (cold constructed run) | — | 591 ms | none | 93 | 0 |

**All five final screens are byte-identical** over the whole 24×80 terminal
(`final_screen`). A game that ran beside another game, a game that ran alone,
and a game that ran cold produce the same dungeon from the same seed — which is
the property that matters, since the page's game and the driver's are different
seeds in the same page.

`start → frame` is unchanged against the page that booted nothing (356 vs
353 ms) and 235 ms better than cold. The preemption itself costs nothing
measurable, which is what the cancellable key pump bought: the first version of
that teardown waited on the pump with a 500 ms bound and put all 500 ms on this
column (868 ms).

### The corners

| what | staged by | outcome |
| --- | --- | --- |
| page's game on `main`, then a driver | `--part2=2000 --transport=main` | page painted at 625 ms on `main`; driver preempted onto a `replay` worker realm, 63 keys, 0 console |
| two interactive games, one page | `--multigame` | game 1 `xhr`, game 2 `xhr`, different characters, 0 console |
| ...with no `Worker` at all | `--multigame=3 --workerless` | game 1 `main`; games 2 and 3 refuse **in words**, 0 console |
| a driver claiming inside the grace | `--part2=30` | page's game never booted; driver adopted the warm realm; screens byte-equal to cold |
| the Session Viewer shape | `--viewer`, `--viewer --judge-stub` | 3/3 sessions each, 0 console |

### Standing gates

| what | result |
| --- | --- |
| `tools/judge-sim/run.mjs seed8000-tourist-starter.session.json` | PASS, 0 mismatches, 0 out-of-scope |
| `tools/judge-sim/run.mjs seed0013-friday13-save-then-fullmoon-restore.session.json` | PASS (multi-segment) |
| `frozen/ps_test_runner.mjs` on seed8000 + seed4500 | 2/2 PASS, RNG 111405/111405, screens 1837/1837 |
| `tools/strict-score.mjs --all` | 0 static violations (355 files, 2 roots), 44/44 sandbox parity |
| `playability.mjs --viewer` / `--viewer --judge-stub` | 3/3 sessions, 0 console, both |

`runSegment()` is untouched by every line of this leg: it never calls
`startEngine()`, so it never preempts anything and nothing preempts it.

### What a human sees now

Nothing to obey. The terminal paints immediately with

```
Starting NetHack with seed 4471...
Using default options — visit /nethackrc/ to edit.

Dealing the dungeon — no need to press anything.
```

and about half a second later — 419 ms measured, with the shipped default
`.nethackrc` — that is replaced by NetHack's own first screen: the copyright
banner and `Who are you?`. Exactly what pressing a key used to produce, without
pressing a key. The line under the terminal now reads *"The game starts by
itself — just type. Click the terminal if your keys don't register."*

`?seed=<n>` is honoured outside bench mode as well, so a player can link the
dungeon they are in; without it the page picks a random one as it always did.

## What could not be verified, and residual risk — the auto-boot leg

- **The grace window is ~70 ms locally, not 300 ms.** It is a claim check rather
  than a timer, so it is exact rather than approximate — but the thing it
  guards, "the page's game has not yet committed to a realm", ends when the
  transport is prepared, and on loopback that is fast. A driver that claims
  between then and the page's first frame (~70–650 ms here) pays a cold boot:
  ~600 ms against ~345 ms. On the judge's slower box the window is wider in
  absolute terms and their claim lands well outside it. Not fixed, because the
  only fixes are to delay the page's game (which is the thing being fixed) or to
  arm a second prewarm at commit time (which is the contention
  `FALLBACK_HEAD_START_MS` exists to avoid) — and the measured cost lands on a
  shape nothing suggests the judge has.
- **The degraded modes lost their fast rung for the page's own game.** ~0.66 →
  ~19.6 ms/move on `--inert-sw` / `--no-sw` / `--hang-sw`, plus the degradation
  banner a `main` rung did not raise. This is deliberate (above) and it is the
  single largest cost in the leg. The alternative design — let the page's game
  take `main`, and let a later driver fall to `replay` — is better for a human on
  a service-worker-less browser and worse for the driver whose ms/move is
  actually scored. If a judged run ever shows the browser check is per-page with
  no constructing phase, that trade should be revisited; the switch is one
  predicate, `workerRungAvailable()`.
  A middle path exists and is not implemented: let the page's game start on
  `replay` and *upgrade* it to `main` if no driver has claimed the engine after a
  few seconds, reusing `RacedEngine._swapIn`. It is attractive and it is a new
  unmeasured mechanism in the one place where "silently wrong engine" has
  happened three times; it wants a bench of its own first.
- **The re-armed prewarm is one more idle realm.** A human who loads the page and
  plays the game it started for them holds a second engine realm, with the
  module graph instantiated, until the tab goes away. It has run no C code, so it
  can never be *wrong*; it can only be unused. That was the stated reason not to
  re-arm, and the shape it now serves is the shape that was failing us.
- **The web font can still log a console line.** Making it non-blocking removed
  it from the critical path; it did not remove the request. If
  `fonts.googleapis.com` is unreachable from the judge's container the failure is
  a network-level console entry, which their check counts — and there is no way
  to ask a browser whether a URL exists without a 404 being logged if it does
  not, the same fact that makes `--no-sw`'s line unavoidable. It is now at least
  *after* the first frame rather than in front of it. The only complete fix is to
  drop the web font and live with `Georgia`; that is a call about the page's
  appearance, not about the engine, and it is recorded here rather than taken.
- **`Input.dispatchKeyEvent` is not every harness's dispatch.** `--shape-b` sends
  keydowns to the focused document over CDP, which is what Puppeteer and
  Playwright do underneath. A harness that instead calls `element.dispatchEvent`
  on a node of its choosing, or drives `display.pushKey` directly, is not
  exercised — though both reach the same `Terminal._onKeyDown`.
- **One page, one auto-boot.** The claim is armed once and preempted once.
  A driver that builds a *second* game after preempting gets the ordinary
  multi-game contract (`--multigame`), which is unchanged; the page's game is not
  re-armed behind it, and should not be.
- **Chrome 141 only, one machine.** Every number here is from the same laptop and
  the same browser. The font-blocking effect in particular is a specification
  behaviour rather than a Chrome quirk, but its *size* is a property of the route
  to `fonts.googleapis.com` from here.

## The page we were never serving

Everything above this line was measured against `index.html` — our play page, in
this repository, driven by `tools/judge-sim/playability.mjs`. On 2026-08-09 we
fetched what `https://mazesofmenace.ai/play/NoahBPeterson/` actually returns and
found out that nobody is ever served it.

The mirror serves **its own page**. It is vendored verbatim, with that
provenance, at `tools/judge-sim/fixtures-judge-play-page.html`, together with
the import map's target from `https://mazesofmenace.ai/shim/node-builtins.mjs`
at `tools/judge-sim/fixtures-judge-shim-node-builtins.mjs`. Our `index.html` is
a file in the fork that the mirror will happily serve at `/` and that no player
and no judge ever navigates to.

That page imports five modules out of this tree and drives them itself:

```js
const [{ GameDisplay }, { NethackGame }, { game }, { moveloop_core }, { vfsReadFile }] =
    await Promise.all([ import('./js/game_display.js'), import('./js/jsmain.js'),
                        import('./js/gstate.js'),      import('./js/allmain.js'),
                        import('./js/storage.js') ]);

const display = new GameDisplay('game-container');
display.flags = { color: true };
display.putstr(0, 0, `Starting NetHack with seed ${seed}...`);   // seed = Math.random() * 10000
display.putstr(0, 3, 'Click here and press any key.');
await display.readKey();                                        // ← the gate
display.clearScreen();

const nhGame = new NethackGame({ seed, nethackrc, storage: persistentStorage });
nhGame._storage = nhGame._pendingStorage = persistentStorage;   // after construction
nhGame._pendingDisplay = display;
game.nhDisplay = display;
await nhGame.start();

for (;;) { await moveloop_core(); if (game.program_state?.gameover) break; }
showGameOver();                                                 // vfsReadFile('/record')
```

`main().catch` logs `console.error(e)` and writes `'Error: ' + e.message` into
`#game-container`, so any throw anywhere in that sequence is simultaneously a
dead terminal and a console line — the two things the browser check fails on.

### The suspicion, and what was actually true

The suspicion going in was that their `for (;;)` loop spins: if `moveloop_core()`
returns immediately when no key is queued, that loop is a hot loop, and "100%
CPU, no console, no error, 0 moves" is exactly the shape of the seven bad
crawls.

**It does not spin, and it never did.** `moveloop_core()` awaits
`display.readKey()`, `GameDisplay.readKey()` forwards `onEmptyQueue`, and their
page never sets one — so `Terminal.readKey()` falls through to
`new Promise(resolve => this._inputResolver = resolve)` and parks until a
keydown arrives at the document handler `Terminal` installed when the display
was built with a container id. Both drivers are satisfied by the same code:
their page parks on a key that has not been typed, and
`frozen/playability_runner.mjs`, which pushes a key *first*, finds it already in
`_inputQueue` and never waits at all. Measured on the fixture: 78 keys sent, 78
frames painted, `inputQueueLength` 0 at the end.

`--their-page` was written to prove that, and instead found two other things —
both invisible from our own page, because our own page happens to do the work
itself.

### Gap 1 — the arrow keys their page does not translate

Their page tells the player, under the terminal, "Move with `hjklyubn` or arrow
keys". It builds a `GameDisplay` and never touches `keyMapper`, so an arrow key
reached `Terminal`'s built-in translation, which answers with the raw ANSI
sequence `ESC [ A`. On the other end of that is real tty NetHack, where `ESC`
cancels the command in progress, `[` is not a command, and `A` takes off your
armour. One arrow, three wrong things — and two keys left in the queue behind
every one of them, because their loop consumes exactly one key per iteration.

The fix that already existed was in `index.html`, where nobody is served it. It
now lives on `GameDisplay` as the default value of `keyMapper`
(`defaultNethackKeyMapper`), so every page that builds one inherits it, and
`index.html` inherits it like any other page rather than re-declaring it. The
replay path is untouched: `frozen/playability_runner.mjs` and the judge's
scoring harness push key codes straight into the queue and never raise a
`keydown` at all.

Staged as a failing test first — `--their-page --arrows` on the unfixed tree:

```
keys consumed            : 42
FAIL: 55 key(s) left unconsumed in the terminal queue
turn counter             : Dlvl:1 ... T:3
```

and after:

```
keys consumed            : 42
turn counter             : Dlvl:1 ... T:2   (0 queued)
```

### Gap 2 — a save no fork owned, and a record nobody could read

Their page hands `NethackGame` a `FrontalLocalStorage`: a Web-Storage-shaped
view that rewrites any key starting `vfs:` to `vfs:<owner>:` and passes every
other key through unchanged. The comment above it says, in as many words, that
this is how a contestant gets browser save/restore for free.

`js/boot/harness.mjs` persists the entire VFS under one key, `c2js-overlay`. No
`vfs:` prefix — so it passed straight through their wrapper, and:

* every fork on `mazesofmenace.ai` shared one localStorage key, so a second fork
  could be handed a save written by the first;
* their "Clear saved games" button, which deletes exactly the keys under
  `vfs:<owner>:`, could not delete ours — a player with a bad save had no way
  out;
* `showGameOver()` calls `vfsReadFile('/record')` from our own `js/storage.js`,
  which reads `localStorage[window.__TELEPORT_VFS_PREFIX + path]`. Nothing ever
  wrote `/record` there, so the panel said `(no record file)` after every death.

Both are fixed in `js/jsmain.js`, in `NethackGame.start()` only —
`runSegment()` never passes through it, so the scored replay's storage contract
is byte-for-byte what it was:

* `vfsNamespaced()` wraps the handle and renames the overlay to
  `vfs:c2js-overlay` on the way through, which their wrapper turns into
  `vfs:<owner>:c2js-overlay`. It reads the bare key when the namespaced one is
  absent, and — the part that had to be got right — *enumerates* it too, since
  their wrapper's `length`/`key()` only walk the fork's own prefix and the
  engine gets its storage as a snapshot built by enumeration. The bare key is
  removed once the namespaced copy is written.
* `publishVfsFiles()` copies `/record` and `/logfile` out of the overlay the
  engine hands back at game end and writes them to `vfs:/record` and
  `vfs:/logfile`, which is where `vfsReadFile()` looks.

A `#quit` was not enough to prove the record end of that. NetHack writes no
topten entry for a 0-point quit — `topten()` only rewrites the record file when
`flg` is set, and a quit at turn 60 with no experience never sets it. That is
authentic and not ours to fix, so the gate only demands a record when the game
wrote one, and `--die` supplies a game that did: seed 31 with the moves of
`sessions/seed0030-ten-diverse-deaths.session.json` segment 1, replayed through
their page, clock pinned from outside because their page passes no `datetime`.

```
their loop broke on gameover: true
their game-over panel    : visible
their vfsReadFile('/record'): "5.0.0 124 2 3 3 0 10 1 20260101 20260101 501 Tou Hum Mal Neu Quincy,killed by a gnome"
localStorage            : vfs:judge-sim:/logfile, vfs:judge-sim:/record,
                          vfs:judge-sim:c2js-overlay, teleport:nethackrc
```

The screen behind it is the recorded death, cell for cell: *"1  124  Quincy-Tou-Hum-Mal-Neu
died in The Gnomish Mines on level 3.  Killed by a gnome."*

### `--their-page`

`tools/judge-sim/server.mjs --their-page` serves the fixture at the fork root
and answers two routes on the judge's side of the fence (`/shim/node-builtins.mjs`,
and Google Fonts, which `playability.mjs` fulfils over CDP so that two failed
subresource loads from *their* markup do not land in a tally that is supposed to
measure our code). Nothing in the fixture is rewritten — not even by
`--judge-stub`, whose whole payload this page already carries for real.

`tools/judge-sim/playability.mjs --their-page` drives it the way their harness
has to: wait for their `putstr` gate to be on the terminal, send **one** key,
then wait for the first game frame **sending nothing more** — which is where a
non-parking `moveloop_core` would show up — then send game keys and check each
one is consumed. Every observation is read through
`import('/js/gstate.js')` inside `Runtime.evaluate`, which resolves to the
module instance their page already imported, so `game.nhDisplay`,
`game.nhEngine` and `game.program_state` are literally the objects their loop is
reading. There is no hook installed in the page and none to trust.

Two things are imposed from outside, both before the page's first line of
script: the first `Math.random()` (their seed is `Math.floor(Math.random() *
10000)`, and a re-runnable measurement needs a known one) and, with `--pin-rc`
or `--die`, `localStorage['teleport:nethackrc']` — their own documented
mechanism, not a hook of ours.

| flag | what it stages |
| --- | --- |
| *(none)* | their `DEFAULT_RC` verbatim, prompts and all — a first-time visitor |
| `--pin-rc` | a fixed character, so ms/move is measured in the dungeon |
| `--arrows` | walks with arrow keys; one arrow must consume one key |
| `--quit` | `#quit` through the disclosure prompts: the gameover break and the panel |
| `--die` | a recorded death: the record, all the way to their panel |
| `--save-reload` | their Save button, then a reload — a returning player's second visit |
| `--legacy-save` | with the above, the save put back at the bare key first |

### What their page measures

Chrome 141, headless, this laptop, loopback unless stated.

| run | gate painted | gate key → first frame | keys | ms/move (engine) | console |
| --- | --- | --- | --- | --- | --- |
| seed 7 | 94 ms | 457 ms (`xhr`) | 70 | 13.3 (5.70) | 0 |
| seed 4242 | 100 ms | 435 ms (`xhr`) | 70 | 14.4 (6.30) | 0 |
| seed 9999 | 93 ms | 409 ms (`xhr`) | 70 | 12.4 (4.86) | 0 |
| `--arrows` | 93 ms | 678 ms (`xhr`) | 42, 0 queued | 8.5 (0.74) | 0 |
| `--die` | 107 ms | 686 ms (`xhr`) | 78 | 9.8 (2.49) | 0 |
| `--save-reload` | 103 ms | 721 ms (`xhr`) | 14 + restore | 10.7 | 0 |
| `--latency=20` | 188 ms | 1132 ms (`xhr`) | 50 | 23.7 (7.66) | 0 |
| `--no-sw` | 89 ms | 322 ms (`main`) | 50 | 11.7 (8.57) | 0 |

The three seeds are three different roles (Caveman, Healer, Priest), which is
the point: their seed is random per load and any of 0–9999 has to work.
`ms/move` includes one CDP round trip per key and is an upper bound; the
engine-thread figure beside it is the clean one. `--latency=20` prices the
mirror's ~170 module round trips: 1.1 s to the first frame, against a browser
check that gives a session about three seconds.

Their page has **no prewarm** — ours warms an engine realm at load and theirs
cannot, since it does not know our modules exist until it imports them. The
gate covers part of it anyway: their `await display.readKey()` sits in front of
the whole game, so whatever time a human (or a harness) takes to press a key is
time the boot does not have to spend afterwards. It is not used, though: nothing
starts until the key arrives.

### Standing gates, after this leg

| what | result |
| --- | --- |
| `playability.mjs --their-page` × seeds 7 / 4242 / 9999 | 3/3 exit 0, 0 console |
| `playability.mjs --their-page --arrows` | 42 keys, 0 queued, exit 0 |
| `playability.mjs --their-page --die` | record read through their panel, exit 0 |
| `playability.mjs --their-page --save-reload [--legacy-save]` | restored both ways, exit 0 |
| `frozen/playability_runner.mjs` | 0 failures, 9096 moves (baseline 9096), 6.13 ms/move (baseline 6.45) |
| `tools/judge-sim/run.mjs seed8000` / `seed0013` | PASS, 0 mismatches, 0 out-of-scope |
| `frozen/ps_test_runner.mjs` seed8000 + seed4500 | 2/2 PASS, RNG 111405/111405, screens 1837/1837 |
| `tools/strict-score.mjs --all` | 0 static violations (355 files, 2 roots), 44/44 sandbox parity |
| `playability.mjs --viewer` | 3/3 sessions, 0 console |
| `playability.mjs --shape-b` | frame at 732 ms with nothing typed, 63 keys, 0 console |

## What could not be verified, and residual risk — the mirror's-page leg

- **The fixture is a snapshot.** It was fetched on 2026-08-09. If the mirror
  changes its page — a different bootstrap order, a `datetime` it did not pass
  before, a storage wrapper with different rules — every number here describes a
  page that no longer exists. There is no way to be notified; re-fetching it is
  a manual step, and the two fixtures carry their source URL and date in the
  server's comments so the check is at least cheap.
- **Their harness's dispatch and patience are still inferred.** `--their-page`
  sends real keydowns over `Input.dispatchKeyEvent` because that is what
  Puppeteer and Playwright do underneath. A harness that instead calls
  `display.pushKey` directly, or dispatches to a node of its choosing, is not
  exercised — though both reach the same `Terminal._onKeyDown` or the same
  queue. The three-second budget is inferred from the crawl behaviour, not
  documented, and 1.1 s at 20 ms of latency is comfortable against it but not
  against a much slower box.
- **Nobody presses the gate key on the judge's behalf, that we know of.** Their
  page will not start a game until a `keydown` reaches the document. If their
  browser check ever loads the page and only *watches*, every fork on the
  leaderboard scores 0 moves and nothing in this repository can change that.
  `--their-page` sends the key because a harness that did not would be measuring
  their page's gate rather than our engine.
- **The record is published at game end only.** `publishVfsFiles()` runs when the
  engine hands its storage back, which is when the game ends. A tab closed
  mid-game leaves `/record` at whatever the last finished game wrote. That
  matches what the panel is for and costs nothing, but it does mean the
  published copy can lag the overlay.
- **The legacy overlay key is migrated on write, not on read.** A player whose
  save is at the bare `c2js-overlay` gets it restored, and it is moved under the
  fork prefix the next time a game *ends*. A player who restores and never
  finishes keeps a key their "Clear saved games" button cannot reach. Fixing
  that properly means writing during boot, which is a write on a path that has
  never needed one.
- **Fonts are stubbed in the measurement.** Their `<link>` to
  `fonts.googleapis.com` is fulfilled from the driver, because headless Chrome
  here has no route to it and two failed subresource loads would otherwise sit
  in a console tally that exists to measure *our* code. On the real mirror that
  request succeeds; if it ever does not, the console line is theirs and lands on
  us anyway, and there is nothing on our side of the fence to do about it.
