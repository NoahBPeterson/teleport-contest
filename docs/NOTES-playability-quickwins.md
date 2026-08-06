# Playability quick wins — what was changed and what it bought

Five changes aimed at `frozen/playability_runner.mjs` (the judge's per-keystroke
playability check) and at the browser fallback the judge's own browser run
landed on. Parity was the gate for every one of them: the full 69-session corpus
is byte-exact before and after.

**All timings on this page were taken on a contended machine** — a second agent
was rebuilding `js/generated/**` and running corpus sweeps throughout, and a
stale `js/boot/worker.mjs` from an earlier session sat on a full core for the
duration (load average 9–47). Every number below is therefore an interleaved
A/B, run back to back in the same conditions, and the honest reading is the
*ratio*, not the absolute. Where a single figure is quoted it is the best of N
runs, which is the least contaminated estimator available here.

---

## 1. cptr.js hot-path micro-optimisation

`js/cptr.js` is 44% of a session's CPU (measured with `--cpu-prof` on
seed4500-knight-coverage: `add` 12.6%, `st1` 6.2%, `sprintfCore` 5.1% + 1.2% in
its replace callback, `ldPtr` 3.4%, `stU64` 2.4%, `ldI32` 1.6%, `cstr` 1.3%,
`memcpy` 1.1%, `decay` 1.1%, plus 8.4% GC that is mostly `add`'s `{buf,off}`).

What changed — all of it internal to cptr, no emitter changes, no observable
semantics:

- **`add`**: the TEMP NaN tripwire is deleted (roadmap 1.12). The common call is
  `add(p, <int literal>)` with no size argument, so that path no longer
  multiplies by a defaulted `sz`, and the body is small and throw-free so
  TurboFan can inline it — which is what lets escape analysis drop the
  allocation at fused sites like `ldI16(add(u, 26))`. `sub` got the same shape.
- **`ldU64` / `ldPtr` / `strlen`**: the never-taken error paths built their
  message inline (a template literal plus a call) inside the hot body. Moved to
  out-of-line helpers with byte-identical messages. `strlen` also bounds its
  scan by `buf.length` instead of counting to 1e6 — the counter could only ever
  fire on a buffer with no NUL in it, which the length bound catches too.
  `ldPtr`'s integer-bit-pattern tail (NetHack's `anything` union) is out of line
  as well.
- **`cstr`**: eight bytes per iteration through one `String.fromCharCode` call,
  with an early-exit ladder so a short string still returns at its NUL. 2.5x
  faster than the byte-at-a-time `s +=` loop on the length mix NetHack decodes.
  `TextDecoder` is *not* usable here: its `latin1` label is windows-1252 in the
  WHATWG standard and rewrites 0x80..0x9F.
- **`memcpy`**: `subarray` instead of `slice` for the staging read.
  `%TypedArray%.set` already copies with memmove semantics when source and
  target share a buffer (ES2023 23.2.3.26.1), so the copy was pure allocation.
  Plain-Array storage has no `subarray` and keeps the `slice`.
- **`decay`**: reordered so a Uint8Array and an existing CPtr each settle in one
  property load.

### 2. sprintfCore fast path

Formats are compiled once and cached (`Map` keyed by the decoded format string,
capped at 4096 entries). The compiled form is a flat list of literal chunks and
conversion descriptors carrying everything the old regex callback recomputed on
every call: parsed width, precision kind, long-ness, flag booleans. Plus an
early bail when the format contains no `%` at all, which is most of them.

The compiler drives the *same* regex with `exec`, so the match set is identical
— a `%` that starts no valid conversion is still left in the literal text
exactly as `String.replace` left it.

**Result**: `sprintfCore` 245 ms + 57 ms (callback) → 54 ms on seed4500;
`cstr` 62 ms → 133 ms in the same profile (work that used to be attributed to
the inlined-into-replace path moved here), for a net −177 ms of ~4.8 s.

### Wins 1+2 measured together

Interleaved A/B on seed4500-knight-coverage (1813 moves, engine only, via
`harness.mjs` — the module-resolution hook in the scratchpad swaps `cptr.js`
for its baseline so the working tree is never mutated mid-run):

| | best of 6 | median of 6 |
|---|---|---|
| baseline | 3951 ms | 4014 ms |
| optimised | 3771 ms | 3824 ms |

**≈ 5% of total session CPU**, with `js/cptr.js`'s share going 43.8% → 41.2%.

Parity gate for both: `SESSION_REPLAY_TIMEOUT_MS=300000 node
frozen/ps_test_runner.mjs sessions/ sessions-extra/` → **69/69 byte-exact**.
Plus `test/printf.test.mjs` (53 cases), the full `node --test` suite, and two
purpose-built differential fuzzers against the pre-change module:

- 200 000 random `printf` formats × arg vectors — 0 mismatches;
- ~150 000 cases over `add`/`sub`/`decay`/`cstr`/`strlen`/`memcpy`/`ldU64`/
  `ldPtr`/`stPtr` including boxes, plain-Array storage, subarray-view spans,
  overlapping copies and out-of-range offsets — 0 mismatches (the only
  divergence, deliberately, is that `add(p, NaN)` no longer throws).

---

## 3. applyFrame diff (`js/game_display.js`) — display only, not scored

Two levels of "don't do the work":

1. if the frame's screen string is byte-identical to the one already on the
   grid, skip the decode (1,920 freshly allocated cell objects) and all 1,920
   `setCell` calls outright. Most keystrokes in real play repaint an identical
   screen: prompts, `--More--`, menu navigation, walking into a wall;
2. otherwise decode and compare cell by cell, calling `setCell` only where the
   frame actually differs.

The shortcut is only valid while `applyFrame` is the sole writer, so every
grid-mutating method on `GameDisplay` (`setCell`, `putstr`, `clearScreen`,
`clearRow`, `scrollUp`, `putChar`, `putString`, `putCharAtCursor`,
`clearToEol`) clears the marker. Nothing outside `game_display.js` writes to
`terminal.*` directly — `index.html` and `js/jsmain.js` both go through
`GameDisplay`.

## 4. V8 compile cache in the engine worker (`js/boot/engine-worker.mjs`)

Every game boots a fresh worker whose first job is to compile the whole
transpiled corpus — ~500 ms of parse/compile before NetHack runs an
instruction. `module.enableCompileCache()` serialises that and replays it.

Guarded to Node (a browser worker has no `node:module`, and the guard is
evaluated *before* `installBrowserGlobals()` installs a stand-in `process`).
Cache directory is the repo's gitignored `.cache/v8-compile-cache`.

Single session, `seed8000-tourist-starter`: **1170 ms cold → 777 ms warm**.

**Caveat worth stating plainly**: under the judge's `node --permission` sandbox
the cache directory is not writable, and `enableCompileCache()` returns
`{status: 0, message: 'Skipping compile cache because write permission … is not
granted'}` — no throw, no behaviour change, and *no speedup either*. Verified:

```
$ node --permission --allow-fs-read=/ -e "console.log(require('node:module').enableCompileCache('/tmp/nope'))"
{ status: 0, message: 'Skipping compile cache because write permission for /tmp/nope/... is not granted' }
```

So this is a local/dev win and a win anywhere writes are allowed; it is not one
on the judge's own harness.

### Wins 3+4 measured on the playability runner

Three-way interleaved A/B over `sessions/` (45 sessions, 9096 moves), full run
of `frozen/playability_runner.mjs` each time. `base` is HEAD-before with all
five changes reverted; `base+cache` adds only the compile cache; `full` is
everything.

| round | base | base + compile cache | full |
|---|---|---|---|
| 1 | 9.071 ms/move (138.3 s CPU) | 7.504 (120.3 s) | **6.989** (114.5 s) |
| 2 | 9.096 (137.5 s) | 8.730 (132.5 s) | 7.907 (125.5 s) |
| 3 | 9.571 (130.6 s) | 9.184 (134.7 s) | 9.486 (127.7 s) |

Round 3 ran while the machine's load average climbed past 32 and should be
discarded. Taking the best of each column — the least contaminated estimator:

- **8.49 ms/move (the original profiling figure) → 6.99 ms/move, −23%**
- process CPU 138.3 s → 114.5 s, **−17%**

An earlier 4-round two-way A/B against the previous `js/generated` snapshot
agreed: 8.05 → 6.15 ms/move best-of-4, −24%.

**This does not reach the 1.0 ms/move threshold and was never going to.** The
runner's aggregate is dominated by the ~1.1 s each session spends booting a game
(9096 moves across 45 sessions ≈ 200 moves per boot), so per-move engine work is
a minority of the number. Getting under 1.0 needs the boot cost attacked
directly, not more micro-optimisation.

---

## 5. The ReplayEngine fallback is no longer quadratic — and now actually works

The judge's browser run did not get a blocking transport (its Chromium never
engaged the service-worker XHR path) and fell through to `ReplayEngine` in
`js/boot/interactive.mjs`, scoring 3156 ms/move.

Two separate faults, both fixed:

**It was quadratic.** It replayed the whole key prefix on *every* key, and each
replay pays a fresh ~1 s boot. Now it replays on a schedule:

- **doubling checkpoints** — replay when the key count has doubled since the
  last replay. Total replayed work telescopes to ~2n instead of n²/2, and the
  number of module-graph instantiations drops from n to ~log₂ n, which is the
  part that actually hurt;
- **stay fresh while it is free** — while the last replay took under 100 ms,
  keep replaying every key;
- **a quiet timer bounds staleness** — 200 ms after the most recent key, replay
  unconditionally, so a human who stops typing (and a harness waiting for a
  settled frame) converges on the true screen. It is also what makes game-over
  observable, since that is only ever learned from a replay.

A key that does not trigger a replay resolves immediately with the previous
frame, and nothing is logged about it — this path has to stay silent because the
judge's browser check fails on any console output.

**And in a browser it did not replay at all.** Isolation came from
`segmentSpecifier(url, n, isolated)`, and `isolated` is false outside Node
(`js/boot/isolation.mjs` needs `module.registerHooks`). So every replay after
the first re-entered the *same*, already-played module graph, crashed on the
spent C globals, and set `exited`. The page declared game over one keystroke in.
Measured with the new `--no-sw` switch below: **1 move, then gameover**, on a
63-key script.

The browser now gets its fresh realm the way the scoring path already does for
segments 2..N — a module Worker running `js/boot/frame.mjs`, which is a fresh
realm with a fresh module map. `frame.mjs` gained one additive field on its
result (`exitCode`) so the fallback can tell "ran out of the keys we were given"
from "the game ended"; scoring ignores it.

### Measured (headless Chrome, `tools/judge-sim/playability.mjs --no-sw --moves=60`, 63 keys)

| | moves completed | ms/move | median | wall |
|---|---|---|---|---|
| HEAD (as shipped) | **1**, then gameover | 207.1 | — | 0.2 s |
| every-key replay, realms fixed | 63 | **759.9** | 752 | 47.9 s |
| doubling + quiet timer (this change) | 63 | **69.8** | 0 | 4.4 s |

**10.9x faster at 63 keys**, and the gap widens with key count — the old
behaviour is quadratic, the new one amortized linear. The median is 0 ms because
most keys resolve against the checkpoint immediately.

Trade-off, by design: the screen lags the keystrokes between checkpoints. At the
end of the 63-key script the painted screen was the 32-key checkpoint (T:16
rather than T:30) until the quiet timer fired. `warnDegradedEngine()` in
`js/jsmain.js` now describes that instead of the old per-key replay.

### The normal path is unaffected

`tools/judge-sim/playability.mjs` (no flags): service-worker XHR transport
engages as before, 243 moves, 3.46 ms/move.

### Console output

`playability.mjs` now extracts page console messages from Chrome's stderr and
reports them (they arrive tagged `INFO:CONSOLE:` regardless of severity, which
is why an earlier filter missed them).

- normal path: **0** page console messages;
- fallback path: **1** — `js/jsmain.js:267`'s deliberate
  `[c2js] no thread to host the resident engine …` degradation warning. It
  predates this work. Nothing in `ReplayEngine` writes to the console.
  **If the judge's check fails on any console output at all, that one line has
  to go** (the on-page banner beside it already carries the same message);
  that is a policy call, not a bug, so it was left alone.

### Testing the fallback

`tools/judge-sim/server.mjs --no-sw` 404s `js/sw.js`, which leaves the page with
no SharedArrayBuffer (no `--coi`) and no service worker, so `startEngine()`
degrades to `ReplayEngine`. `tools/judge-sim/playability.mjs --no-sw` passes it
through. Test-only: the real mirror always serves `js/sw.js`, and nothing in
`interactive.mjs`'s transport selection was touched.

---

## Gates run

- `node --test test/*.test.mjs` — 4/4 (printf 53/53, libc-string 1867/1867,
  posix-ere 23996 differential cases, cmachine).
- `SESSION_REPLAY_TIMEOUT_MS=300000 node frozen/ps_test_runner.mjs sessions/
  sessions-extra/` — **69/69 byte-exact**.
- `node tools/judge-sim/run.mjs seed8000-tourist-starter.session.json` — PASS,
  0 out-of-scope requests.
- `node tools/judge-sim/run.mjs seed0013-friday13-save-then-fullmoon-restore` —
  PASS, both segments (segment 2 goes through the changed `frame.mjs`).
- `node tools/judge-sim/run.mjs seed0030-ten-diverse-deaths` — PASS, all 10
  segments match in the browser.
- `node tools/judge-sim/playability.mjs` — 243 moves, xhr transport, 0 page
  console messages.
