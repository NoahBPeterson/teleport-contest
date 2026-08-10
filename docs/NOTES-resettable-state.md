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

## 6. Gates

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

## 7. What this does not do yet (leg 2)

Nothing on the scoring path calls any of it. `js/jsmain.js:runSegment` still
forks per segment, and `js/boot/reset-realm.mjs`'s only consumer is the
differential. That is deliberate: leg 1 was to make the reset exist and prove it
exact.

Leg 2 is the switch, and these are the pieces it has to handle:

1. **`runSegment`.** Replace `import(segmentSpecifier(HARNESS_URL, n, isolated))`
   with a process-wide resettable realm. Watch `segmentCount` (`jsmain.js:66`) —
   it currently selects the fork tag *and* gates the browser pristine-realm
   branch (`pristine && n === 1`), so it cannot simply be retired.
2. **A fallback that is not a lie.** `acquire()` throws when the graph cannot be
   forked, and `reset()` returns false on a build without `C2JS_RESET=1`.
   `runSegment` must keep the fork path for those cases rather than silently
   running a second game in a spent realm — the failure mode isolation.mjs
   already warns about.
3. **The browser.** `reset-realm.mjs` needs `module.registerHooks` to own a
   graph. A page has no such thing, so segment 1 would use the page's own
   (pristine) graph and reset it for segments 2..N, retiring the per-segment
   `frame.mjs` Worker. `globalThis.__c2jsEngineRealmUsed` (`jsmain.js:293`) has
   to be reconsidered at the same time: it deliberately survives re-import, and
   leaving it set forces every later segment into a Worker realm.
4. **The interactive/yield rung.** `js/boot/main-thread-engine.mjs` has its own
   `forkSeq`, `claimed` and `graph` memo, and `releaseForkedGraph()` already
   does a partial teardown that misses `__nextBufId`, `__bufIds`, `__nextFd` and
   `__fdHooks`. It should call the reset instead of its own subset. The yield
   build (`js/generated-y/`) needs `resetify.mjs` run over it too — the pass is
   directory-agnostic but is only wired to `js/generated/` today.
5. **`__segCounter`** (`harness.mjs:54`) is dead but incrementing. If anything
   ever reads it, it needs resetting.

### Composition with the unmerged `lua-port` branch

`lua-port` introduces a `PORTS` state that this pass has never seen. Two things
it will need:

- **It must be in the census.** If `PORTS` is a module-level `const` bound to a
  Map, a class instance, or anything that is not a typed array / CPtr / box /
  Array, `S()` **throws by design** rather than silently leaving the previous
  game's object in place. That is the intended failure: add the classification
  to `reset-census.mjs`, and `resetify.mjs` picks it up. Run
  `node tools/c2js/reset-census.mjs --unknown` first on that branch.
- **If it holds identities, it must be in §3.** Anything on that branch that
  allocates ids, or that a Lua table iterates, joins `__bufIds` and
  `__ptrRegistry` as parity-observable. The differential will catch it — the
  ten-segment acid test exercises level generation heavily — but only if the
  pair set includes a session that reaches the new code.
