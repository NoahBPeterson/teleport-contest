# Resettable state — one realm, unlimited games

`docs/PROFILE-2026-08.md` §5.1 names module instantiation as the largest thing
in the profile: **44% of a short session's CPU, none of it game work**, paid
*per segment* because `js/boot/isolation.mjs` gives each segment a distinct
`?c2jsseg=N` URL, and a distinct URL is a distinct script to V8. Four
consecutive forks in one process cost 490 / 401 / 440 / 439 ms — fork 4 costs
what fork 1 cost — and each forked graph strands **69.8 MB** that Node can never
unload. `seed0030-ten-diverse-deaths` is the bill: one session, ten segments,
1,156 MB and 8.9–10.8 s in a single child.

This is the other way to get a fresh realm: **keep the graph and put its state
back**. A reset costs **0.6 ms** and **0.6 MB**.

| | fork a graph | reset the graph |
|---|---|---|
| per segment | 440 ms | **0.62 ms** (median, n=11) |
| heap per game | 69.8 MB | **0.6 MB** |
| one-time cost | — | 3.8 ms capture, 0.6 MB snapshot |

The comparison that matters is not the speed, though. It is that the output has
to be **byte-identical to a fresh realm**, and that is what most of this page is
about.

---

## 1. What is reset

`tools/c2js/reset-census.mjs` derives the list from the emitted source rather
than from a memory of it, because the list is ~1,400 declarations across 176
machine-generated modules and it changes whenever the transpiler does.

| kind | strategy | count | let | const |
|---|---|---|---|---|
| `cptr.lit("...")` | **none** — see §2 | 24,163 | 0 | 24,163 |
| number | rebind (let only) | 4,291 | 131 | 4,160 |
| `cptr.alloc/malloc` | snapshot | 717 | 165 | 552 |
| `cptr.bytes("...")` | snapshot | 239 | 0 | 239 |
| typed array | snapshot | 101 | 0 | 101 |
| null pointer | rebind | 75 | 75 | 0 |
| array literal | snapshot | 48 | 0 | 48 |
| `cptr.box` | snapshot | 42 | 42 | 0 |
| 2-D row-view IIFE | snapshot | 36 | 0 | 36 |
| alias / BigInt / `NHC.*` / `cptr.decay` | mixed | 26 | 26 | 0 |
| `Array.from` 3-D table | snapshot | 1 | 0 | 1 |

**1,395 bindings in 146 of the 167 live modules.** A `const` bound to a number
needs nothing (4,160 of them); a `const` bound to an arena needs its *bytes*
back even though its binding cannot move; a `let` bound to an arena needs both.

### The manual census was wrong, and wrong in the worst place

A hand-written census had 324 top-level `let` and 892 mutable `const`. The
derived numbers are 439 and 977. The entire difference is `export`:

```
plain  const … = cptr.alloc(…)   498      export const …   54
plain  const … = cptr.bytes(…)   223      export const …   16
plain  let                       324      export let      115
```

The 24,163 immutable literals match to the digit, which is what makes the
comparison trustworthy. **115 exported `let`s were missed** — and an exported C
global is precisely one that other modules read, i.e. the most shared state in
the graph. A reset built from the hand list would have left all of it behind.

The analysis runs over the **emitted** source, through `tools/c2js/jslex.mjs`,
for the reason `yieldify.mjs` gives: `build.mjs` inlines the hand-written
runtime preludes into the generated modules verbatim and `emit.mjs` never sees
them. `rnd.js`'s `__rngLog` — the scored RNG log — is declared in one of them.

Anything it cannot classify is **reported, not skipped**. Two showed up on the
first run (a folded `(171 - 1) | 0`, and `vision.js`'s 3-D `Array.from` table);
both are classified now and the count is zero.

---

## 2. The literals, which are 95% of the declarations and are left alone

`cptr.lit(s)` is how a C *string literal* is emitted. Writing through a string
literal is undefined behaviour in C and NetHack does not do it, so restoring
24,163 buffers on every reset would be pure cost.

"Does not do it" is not proof, so it is checked:

```
$ node tools/c2js/reset-census.mjs --verify-lits seed4500
lit buffers watched: 30889
written through:     0
```

Every `lit()` buffer handed out during the longest single session in the corpus,
watched against a copy of its own bytes. Zero moved. `cptr.bytes("...")` — a C
`char[]` initialiser, which C *is* entitled to write into, and does — is a
different classification and is snapshotted.

---

## 3. The hard part is identity, not bytes

Two of the things reset are numbering schemes whose output C can see.

### `__ptrRegistry`

A stored pointer's id **is** its index in this array. A fresh realm's second
segment starts numbering from wherever *evaluation* left off — 9,956 entries,
all from top-level `stPtro` initialisers — not from wherever the previous game
left off (186,811 after a 22-move session, 1,037,119 after seed4500). Truncating
to the captured length reproduces that exactly: entries below it are the same
objects the same initialisers put there, and the arenas holding those ids have
been restored to the same bytes.

### `addr()`'s buffer ids — the subtle one

`__bufIds`/`__nextBufId` hand out an id on first touch, and those ids are not
decorative. The transpiled Lua reads them as:

- the string-hash seed for a `lua_State` (`generated/lstate.js:39,45,51`),
- `math.random`'s `seed2` (`lmathlib.js:364`),
- the hash deciding table slot placement, and therefore `next()` **iteration
  order** (`ltable.js:90,95,100`), and the string-table bucket
  (`lstring.js:193`).

NetHack generates levels through that VM (`des.*`, `themerms.lua`, `quest.lua`).
A reset that left the identity map populated would give game 2 different Lua
seeds and a different table iteration order than a fresh realm — surfacing as a
differently generated dungeon, diagnosed a very long way from its cause.

So the map is **replaced outright** and the counter restored, which makes game
2's first touch a first touch again. That this is *exact* rather than merely
plausible rests on a measurement:

```
after cptr.js only:              nextBufId 1,   ptrRegistry 0
after generated graph eval:      nextBufId 1,   ptrRegistry 9956
after one 22-move game:          nextBufId 374, ptrRegistry 186811
```

**Nothing takes an address during graph evaluation** — `cptr.lit` allocates but
never calls `addr` — so the counter is still 1 when the last of the 176 modules
finishes, and restoring it to its captured value reproduces a fresh realm's
numbering. `cptr.js` keeps an ordered log of pre-capture id assignments and
replays it on reset anyway. The log is empty today; it exists because "no
addresses at evaluation time" is a property of the emitted code, not of the
design, and its absence would be a silent parity bug rather than a loud one.

### The rest of `js/cptr.js`

`__intPtrs` (identity-compared sentinels), `__fds`, `__nextFd`, and `__fdHooks`
— a closure over the finished run's VFS, and a retention leak — are all reset.
`__fmtCache` is a **provably** content-keyed cache (key is the decoded format
string, value is `compileFormat(key)`, never mutated after insert, eviction is a
wholesale clear) and is cleared anyway: it holds 78 entries on a real session,
and matching a fresh realm exactly is worth more than rebuilding them.

`js/boot/harness.mjs` needed nothing — its VFS overlay, fd table, env, tty state
and regcomp cache are all **function-locals of `runBootGame`**, recreated per
call. `js/boot/posix-ere.mjs` has no cache at all (`ereCompile` is a pure
function of the pattern). `js/isaac64.js` threads its state through `ctx`.
`js/data-nethackdir`'s decode cache is immutable and deliberately shared across
forks already.

---

## 4. Two bugs the barrel found, both pre-existing and both silent

- **`js/generated/isaac64.js` does not compile.** It imports `isaac64_init` and
  then declares it. Nothing had ever noticed, because nothing has ever loaded it
  — the transpiled `rnd.js` imports the hand-written `js/isaac64.js` instead. A
  barrel built from `readdir()` loads it and dies.

- **A barrel over `readdir()` would have corrupted the thing it measures.** Nine
  modules are outside the graph. Pulling them in runs their top-level
  initialisers, pushing pointer-registry entries a real boot never has — so the
  reset realm's *first* game would already number pointers differently from the
  reference. The barrel imports only what a boot reaches, **entry first**,
  because a barrel's import order *is* the graph's evaluation order.

---

## 5. The differential, and the red that makes the green mean something

`tools/reset-diff.mjs` runs `session A to completion, reset, session B` in one
realm and compares B against B run through the `?c2jsseg=N` fork path — the path
`js/jsmain.js:runSegment` uses today and the 69/69 corpus certifies. It compares
screens, cursors, the RNG log, animation frames, stdout, exit code and thrown
errors, and reports the *first* divergence rather than a score.

Reference and test share a process on purpose: a forked graph is independent of
every other graph, so the reference is sound, and both then share a machine, a
heap and a JIT state. Reference realms are acquired **unarmed** — no snapshot,
nothing this tooling adds — so they are bit-for-bit what `runSegment` acquires.

All twelve pairs run in **one realm**: roughly 40 games through a single graph,
because "two games per graph" is not the claim.

| pair | reset = no-op (`--force-noop`) | reset |
|---|---|---|
| seed8000 → seed8000 (self) | FAIL | **PASS** |
| seed8000 → seed4500 | FAIL | **PASS** |
| seed4500 → seed8000 | FAIL | **PASS** |
| seed0002 → seed0006 | FAIL | **PASS** |
| seed0006 → seed0002 | FAIL | **PASS** |
| seed0004 → seed0007 | FAIL | **PASS** |
| seed0007 → seed0013 *(acid 1)* | FAIL | **PASS** |
| seed0013 → seed0013 *(acid 1, self)* | FAIL | **PASS** |
| seed8000 → seed0030 *(acid 2)* | FAIL | **PASS** |
| seed0030 → seed0030 *(acid 2, self)* | FAIL | **PASS** |
| seed0030 → seed4500 | FAIL | **PASS** |
| seed0013 → seed0030 *(both acid tests)* | FAIL | **PASS** |

The acid tests are the two multi-segment sessions — `seed0013` (save then
restore, 2 segments) and `seed0030` (ten segments) — because those are the only
sessions where a reset has to stand in for a fork *inside* one session.

`--force-noop` makes `reset()` a no-op that reports success. Every pair must then
fail, and on this build every pair does, crashing in segment 0 of B on the
previous game's C globals. **A harness that cannot fail on a deliberately broken
reset is not evidence of anything**, which is why the no-op column exists.

Incidentally: `seed8000 → seed0030` runs *both* sessions through the reset path
in 4.7 s, against 11.5 s for the reference to run seed0030 alone.

---

## 6. Gates, leg 1

These are the leg-1 numbers: the reset emitted, proven exact, and *not yet
called by anything*. §8 is the leg-2 set, run against the switched paths.

- `tools/reset-diff.mjs` — **12/12** pairs byte-identical to a fresh realm;
  **0/12** with `--force-noop`, as required.
- `frozen/ps_test_runner.mjs sessions/ sessions-extra/` — **69/69 byte-exact**
  with the reset functions emitted and unused. Every RNG and screen metric is
  n/n; the corpus is the proof that emitting them changes nothing.
- **Flag off ⇒ byte-identical output.** A full `build.mjs --all` with
  `C2JS_RESET` unset reproduces `js/generated/*.js` byte-for-byte
  (`git diff` empty against the pre-pass commit). With `C2JS_RESET=1` it
  reproduces the committed reset build byte-for-byte — the pass is
  deterministic and idempotent.
- `C2JS_FOLD_VERIFY=1` — **301,692 folds evaluated, 0 mismatched, 0
  unevaluable**. (Note for whoever runs this next: audit mode adds *unused*
  imports — `NHM`, `NHC`, `In_hell`/`In_mines` — to 12 modules. No emitted code
  changes, but a fold-verify build's output is not shippable. Pre-existing.)
- `node --test test/*.test.mjs` — 4/4 (printf 53/53, libc-string 1867/1867,
  posix-ere 23,996 differential cases, cmachine).
- `node tools/strict-score.mjs` — 355 files reachable, **0 violations**,
  sandbox parity OK on 3 sessions.

The rebuild used the sibling checkout's AST cache read-only via a symlink inside
this worktree, and a local copy of the IR. `build.mjs` never writes ASTs (it
errors and tells you to run `ast-dump.mjs`), so the symlink cannot be written
through. The sibling's `nethack-c/recorder/src` was verified against the
`Input sha256:` headers in the generated modules before being used.

---

## 7. Leg 2 — the switch

Leg 1 built the reset and proved it exact against a fork. Nothing called it.
Leg 2 puts it on the two paths that were paying for forks: the scored replay,
and the interactive rung a sandboxed Node lands on.

### 7.1 `runSegment` — one graph for the whole process

`js/jsmain.js`'s Node branch acquires **one** resettable realm, lazily, and runs
every segment in it. `Realm.run()` resets first when the graph already ran a
game, so the reset happens between segments of one session as well as between
sessions.

`segmentCount` was not retired. It never was about forking alone: it still tags
the fallback's URLs, and `n === 1` is half of the browser's pristine test
(`pristine && n === 1`). It costs one increment and it stays honest.

**The fallback is the fork path, unchanged.** Two things can deny a realm, and
neither is answered by running a second game in a spent one:

| | what runSegment does |
|---|---|
| no `module.registerHooks` | `acquire()` refuses to take the shared graph, so it throws; the fork path runs, and `enableSegmentIsolation()`'s **non-quiet** degradation notice still reaches whoever needed it |
| no `C2JS_RESET=1` barrel | the realm comes back `resettable === false` — but it is still a private forked graph that has never run anything, so **segment 1 runs in it** and segments 2..N fork as before. Nothing is wasted and nothing is reused |

Exercised, not assumed: the whole corpus was run once with
`js/generated/__reset.js` moved out of the tree — **69/69, 940+0.75/turn, 2:02**
against **69/69, 900+0.53/turn, 1:45** with the reset.

### 7.2 The bug a shared graph introduces, which forking hid

`runBootGame` returns `rngLog` as `rnd.getRngLog()` — `js/generated/rnd.js`'s own
`__rngLog` **array**, not a copy. Under the fork path that was harmless: segment
N's `rnd.js` is a module nothing else will ever run in. Under reset it is the
same array the next game logs into, and the restore refills it **in place**
(that is the whole point of the by-value snapshot — a binding another module
captured has to land on the same object). A judge holding segment 1's game
object, running segment 2, and only then calling `getRngLog()` would have read
an empty array: a scoring failure with no visible cause, in the observable that
counts most.

`Realm.run()` slices it. The other four fields are built by `harness.mjs` out of
its own locals and alias nothing in the graph — checked at the one place a
result is constructed, not assumed.

This is exactly the class of bug `--via runsegment` below exists to catch, and
it is worth noticing that the leg-1 differential could not have: it slices every
field into its own observation before comparing.

### 7.3 The interactive rung — the number this was all for

`js/boot/main-thread-engine.mjs` asked `forkGraph()` for a private graph per
game. That worked and it had a wall in it, measured in
`docs/NOTES-async-engine.md`: a forked graph can never be unloaded, so by
session 20 the heap was 1.6 GB and *boot* had gone from 580 ms to 1600 ms;
session 21 spent 94 s in boot, session 22 spent 354 s and the run did not
finish. **"The full 44-session sandboxed aggregate is therefore not a number
this branch can report"** is what that file had to say.

It is now:

```
node --permission --allow-fs-read="$PWD/*" frozen/playability_runner.mjs

  44 sessions, 0 failures, 9096 moves, 28.0 s
  3.03 – 3.08 ms/move aggregate  (three runs: 3.084, 3.030, 3.049)
```

Against the fork path's own aggregates on the same corpus and the same machine:
6.61 ms/move for the first ten sessions, 10.18 for the first twenty, and no
number at all for forty-four.

`acquireGraph()` composes the two rungs — reset first, fork second — and
`_finish()` hands the graph back through whichever one it got: `releaseForkedGraph()`
for a fork (which could only ever give back the pointer table and the RNG log,
because a fork's 176 modules are unloadable) or `resetResidentGraph()` for a
realm, which gives back **everything**. The reset is done at game *end* rather
than before the next game, which is the opposite of `Realm.run()`'s own default
and is deliberate: the driver measures the heap *between* sessions, and a reset
deferred to the next boot would make the curve look like the fork's while being
nothing like it. Parity is unaffected either way — the reset happens between the
two games, which is all the differential ever claimed.

**Boot collapses to `newgame()` after game 1**, which is most of where the time
went. Same sandbox, three games in one process:

```
game 0   mode=main  warmed=false  graphMs=384  bootMs=77
game 1   mode=main  warmed=true   graphMs=0    bootMs=41
game 2   mode=main  warmed=true   graphMs=0    bootMs=39
```

`graphMs=0` is the whole switch in one number: game 2 pays nothing to get a
graph. (`warmed` is now true for a realm past its first game — it means what it
means on every other rung, "the graph was in this realm's hand before the game
asked for it".)

**And the memory is flat.** RSS over the 44-session run sawtooths between ~490
and ~1163 MB with no ramp, which is GC latency rather than accumulation — and
the proof of that is the same run completing under a hard cap:

```
node --max-old-space-size=512 --permission --allow-fs-read="$PWD/*" \
     frozen/playability_runner.mjs
  → 44 sessions, 0 failures, 3.05 ms/move, 28.0 s
```

512 MB. The fork path's own `roomForAnotherGraph()` reserves 400 MB *per fork*
and would have refused the second game outright.

`roomForAnotherGraph()`, `RealmExhausted` and the refusal it throws are all
still there. They now guard a rung that is only reached when there is no reset,
which is the correct place for them.

### 7.4 Both builds, and how the two passes compose

`js/generated-y/` — `yieldify.mjs`'s whole-program rewrite — needed the same
treatment, and it could not inherit it. `resetify.mjs` grew `--dir`, and
`build.mjs` runs it once per directory (**after** `maybeYield`, which rewrites
that directory from scratch).

It could not inherit it because of what the rewrite would do to the block:

```js
// yieldify over a js/generated/ that already has reset blocks:
export function* __captureState(S) { __c2js_rs = [(yield* Y.icall(S(enc_stat))), ...
```

`S` is a parameter, so every `S(x)` is a call through a function pointer, so the
colouring wraps it and `__captureState` becomes a **generator** — which the
barrel calls directly. The yieldable build's reset would have thrown on first
use. So `callgraph.mjs` strips the delimited block (and skips `__reset.js`)
before scanning, which has a second, better consequence: **`js/generated-y/` is
byte-identical whether or not the sync build was built with `C2JS_RESET=1`.**
Verified — a `yieldify.mjs` run after the strip reproduced the committed
directory to the byte, and the fn-ptr wrap count dropped 4,501 → 1,711, which is
precisely the reset blocks that should never have been in the analysis.

Both directories report the same census: **146/167 live modules, 1,395
bindings.** They should, and now it is a fact rather than a hope: yieldify emits
no top-level coloured call (its pre-flight asserts it), so the top-level
declarations the census reads are the same ones in both.

### 7.5 `__segCounter`

Still dead — assigned at `harness.mjs:104`, read nowhere (checked across `js/`,
`tools/` and `frozen/`). It behaves *differently* now and that is worth writing
down: the fork path gave every segment its own `harness.mjs`, so `segId` was
always 1; one realm makes it count 1, 2, 3. Nothing observes either. It stays in
`reset-census.mjs`'s `RUNTIME_STATE` table, which is where the note lives that
it cannot be made live without a reset — `harness.mjs` is hand-written and not
in the barrel, so making it live would mean resetting it by hand.

### 7.6 The browser — deferred to leg 3, and why

Not switched. `reset-realm.mjs`'s `acquire({fork: false})` would work in a page
(segment 1 in the page's own pristine graph, reset for 2..N, retiring the
per-segment `frame.mjs` Worker), and the yield build's barrel would do the same
for `main-thread-engine.mjs`'s one-game-per-page limit.

The reason not to is not difficulty, it is evidence. **The only reason to
believe a reset is the differential**, and `tools/reset-diff.mjs` is a Node tool:
it needs `module.registerHooks` to build the *reference* — a forked graph per
segment — and a page has none. Switching the browser now would mean shipping the
one part of this design that rests on measurement, without the measurement.

What the browser would gain is also small and lands in the wrong place. Scored
replay is Node; the browser scored path exists for the judge's *browser check*,
which is single-session, and it already works. The interactive gain is confined
to a browser with neither SharedArrayBuffer nor a service worker playing a
*second* game in one page load — where the answer today is a refusal in words
and a reload. Against that: the page is where console silence and the mirror's
play-page contract are gated, and both are things this tree has been bitten by.

Leg 3's prerequisite is therefore a **browser-side reference**, and it already
half exists: `tools/judge-sim/run.mjs` runs a session in real headless Chrome
and diffs its per-segment digests byte-for-byte against a Node reference. A
page-side `A, reset, B` driven through `driver.html` and compared to a
per-segment-Worker reference is the same shape, in the place it has to be.

---

## 8. Gates, leg 2

Everything in §6 still holds and is not repeated. What leg 2 had to show:

| gate | result |
|---|---|
| `reset-diff --via runsegment` — 12 pairs **through `js/jsmain.js:runSegment`**, incl. both acid tests | **12/12** byte-identical to a fresh realm (48 s) |
| ...and the same with `--force-noop` | **0/12** — every pair fails, as it must |
| `reset-diff --build yield` — the same 12 pairs on `js/generated-y/` | **12/12** (see §8.1) |
| ...and `--force-noop` on two of them | **0/2** |
| `ps_test_runner sessions/ sessions-extra/` through the switched path, twice | **69/69** and **69/69** (935+0.53/turn, 900+0.53/turn) |
| ...once with the reset unavailable (barrel removed ⇒ fork fallback) | **69/69** (940+0.75/turn, 2:02 vs 1:45) |
| sandboxed `playability_runner.mjs`, all 44 sessions, one process | **completes**: 0 failures, 9096 moves, **3.03–3.08 ms/move**, 28.0 s |
| ...under `--max-old-space-size=512` | completes, 3.05 ms/move — no accumulation |
| unsandboxed `playability_runner.mjs` | unchanged: rung is still `sab`, 0 failures, 9096 moves, 4.63 ms/move |
| `judge-sim/run.mjs` seed8000, seed0013 | **PASS**, 0 segment mismatches, 0 out-of-scope requests |
| `judge-sim/playability.mjs --their-page` × 3 seeds (4242, 8000, 1337) | 130 moves each, `xhr`, **0 console entries**, 0 out-of-scope |
| `judge-sim/playability.mjs` production | `xhr`, 243 moves, 2.04 ms/move, 634 ms first frame, **0 console** |
| `judge-sim/playability.mjs --no-sw` | `replay`, 243 moves, 19.2 ms/move, **1 console** — the pre-existing browser-emitted 404 on the deliberately-missing `js/sw.js`, unchanged |
| `tools/strict-score.mjs` | 356 files reachable (355 + `js/boot/reset-realm.mjs`), **0 violations**, sandbox parity OK on 3 sessions |
| `node --test test/*.test.mjs` | 4/4 |
| **flag off** ⇒ `build.mjs --all` reproduces `js/generated/` | byte-identical to the pre-pass commit `0095ad2` (only `__reset.js`, which is resetify's own artifact, remains) |
| **flag on** ⇒ `C2JS_YIELD=1 C2JS_RESET=1 build.mjs --all` | reproduces the committed `js/generated/` byte-for-byte **and** `js/generated-y/` + `harness-y.mjs` identically |

The measurement that reads best on its own: `seed0030-ten-diverse-deaths`, ten
segments in one session, was **8.9–10.8 s** through the fork path and is
**3.6 s** through the reset.

### 8.1 The yield differential had to be run one pair per process

Eight of the twelve pairs ran in one process and passed. The ninth —
`seed8000 → seed0030` — did not finish: **380% CPU against a 1.5 GB live set,
no progress in seven minutes**, and it was still there when it was killed.

Nothing was wrong with the reset. The *reference* side forks a graph per
segment, and a yieldable graph is ~190 MB of unloadable module map against the
sync build's ~70 MB. Seventeen of them is the wall in
`docs/NOTES-async-engine.md`, met in the one place in this design that cannot
use the cure: a differential's reference has to be a fork, or it is not a
reference.

One pair per process, and each of the four takes 10–20 s:

```
seed0030 -> seed0030   PASS   19 resets, 10 reference forks   17 s
seed8000 -> seed0030   PASS   10 resets, 10 reference forks   13 s
seed0030 -> seed4500   PASS
seed0013 -> seed0030   PASS
```

That is 12/12, and it is also the clearest possible restatement of what leg 2
bought: the thing under test served twelve pairs — roughly forty games — in one
realm at 0.6 ms apiece, while the thing it replaced could not get through nine.

---

## 9. Leg 3

### 9.1 The browser

§7.6. The prerequisite is a page-side reference, not a page-side reset.

### 9.2 Composition with the unmerged `lua-port` branch

Scouted, read-only, with `reset-census.mjs --dir` (new) against a `git archive`
of `lua-port:js/lua-js` — **9 modules, 83 top-level declarations, 19
unclassified.** The originals of that run are reproducible with:

```
git archive lua-port js/lua-js | tar -x -C /tmp/luaport
node tools/c2js/reset-census.mjs --dir /tmp/luaport/js/lua-js --unknown
```

**A bug in the census had to be fixed before that number meant anything.** The
first run reported 25 unclassified declarations in `bridge.mjs`, most of them
things like `const base = lua_gettop(Lp)` — which are *function locals*. One
line was responsible:

```js
export const { nhRandom, mathRandom, percent, d, shuffle } = makeNhlib(rn2);
```

A **destructuring** declaration. The declarator walk breaks on the `{` (it is
not an identifier), and the scan then resumed *past* it, so the brace counter
never saw the `{` while its `}` drove the depth to −1 — and every function body
in the remaining 700 lines looked like module scope. The c2js emitter produces
no destructuring, which is why nothing had ever met it. Fixed two ways, and both
were needed: the scan no longer steps over the brace, and a destructuring
declaration is now reported as **unclassified** rather than skipped — so
`resetify.mjs` refuses to emit a short block for the module instead of silently
leaving its bindings out of the reset. `js/generated/` is unaffected to the byte
(`resetify --check`: up to date, both directories).

What leg 3 then has to do with the 19:

- **Most are immutable and need a classification, not a reset.** `PORTS`,
  `READBACK`, `LIBRARY` (Maps built once from module constants), the frozen API
  tables `des` / `selection` / `obj` / `string` / `api` / `uTable` / `nhc`, and
  the lookup objects `RESULT_FIELDS` / `TYPE_NAMES` / `DES_VALUE_FUNCS` /
  `tutorial_blacklist_commands`. Each needs to be *shown* immutable, not
  assumed — the census's job is to make that a list somebody signed off, and
  `S()` throwing is what keeps an unexamined one from shipping.
- **Two are genuinely mutable and must be reset.**
  `registry.mjs`'s `unportedLua = new Map()` accumulates a per-run tally, and
  `bridge.mjs`'s `cstrCache = new Map()` interns `cptr.lit()` buffers by string.
  The second is the §3 hazard this page predicted, arriving exactly where it was
  predicted: those buffers are what `addr()` hands ids to, and those ids are the
  Lua string-hash seed, `math.random`'s `seed2`, and the hash deciding `next()`
  iteration order. A second game holding the first game's interned buffers is
  the "differently generated dungeon, diagnosed a very long way from its cause"
  case. Clear it.
- **`interp-state.mjs` is already classified and already right**: `installed`
  (bool), `portState` (null pointer), `candidates` (array) — a reset puts the
  interpreter back to "not installed", which is what a fresh realm has.
  `registry.mjs`'s `armed`, `levelProbed`, `questProbed`, `loads` likewise.
- **The pair set must reach the new code.** The differential can only catch what
  a session executes. `seed0030` (ten segments, heavy level generation) does
  exercise the Lua VM, but leg 3 should add a pair that provably reaches a
  *ported* script — the branch's own probes (`C2JS_LUA_LEVELPROBE`,
  `QUEST_PROBE`) name which ones.

### 9.3 Smaller

- `tools/reset-diff.mjs --build yield` has to be driven one pair per process
  (§8.1). A reference digest cache on disk would fix it properly and make the
  yield differential a routine gate rather than a shell loop — the observations
  are already the only thing that needs to survive, and they are small.
- The census's `--dir` now accepts hand-written `.mjs`, but the analysis behind
  it was built for the emitter's output. The destructuring bug in §9.2 is the
  kind of thing that finds: leg 3 should run it over `js/boot/` and `js/libc/`
  before trusting it on `js/lua-js/`.
- `strict-score.mjs` walks `js/generated-y/` but not either `__reset.js`: the
  barrels are reached by a computed URL, by design. They are machine-generated
  and contain no imports a walk would object to, but nothing checks that.
