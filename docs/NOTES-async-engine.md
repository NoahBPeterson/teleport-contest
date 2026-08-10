# The yieldable engine

*Exploratory leg. Branch `async-engine`. Nothing here is on the scored path.*

## The problem, stated exactly

The transpiled engine is straight-line synchronous C. `tty_nhgetch()` calls
`getchar()` and expects a byte back on the same stack, forty-odd frames deep.
Getting a byte there requires a thread that is allowed to block, and a browser
main thread is not. `docs/NOTES-transport-ladder.md` documents the three ways
we buy such a thread today — `Atomics.wait` on a SharedArrayBuffer (needs
`crossOriginIsolated`, which static hosting cannot give), a synchronous XHR
parked by a service worker (needs the blocking realm to be a controlled SW
client), and a dedicated worker to hold either — and the fallback for when
none of them is available: `ReplayEngine`, which re-runs the whole key prefix
in a fresh realm on a doubling schedule. That fallback costs **~21 ms/move**
against ~1.2 ms (SAB) and ~2.4 ms (XHR).

This leg asks the other question. Not *how do we find a thread that can
block*, but *what if the engine did not need one*. If every function that can
reach `getchar()` were a generator, the engine could suspend its entire C
stack into heap objects, return to the event loop, and resume on the next
keypress. No worker, no SAB, no service worker, no blocking — a resident
engine on the main thread, which is the one configuration the ladder has never
been able to reach.

The synchronous engine and the scoring path are untouched throughout. A
slower scoring path would sacrifice the speed crown, so any yieldable engine
ships as a parallel build.

---

## Phase 0 — the colouring census

"Colouring" here is the function-colour problem from the async literature: a
function that can reach a blocking point is *coloured*, must change shape, and
colours every one of its callers.

### Tooling

| file | what it is |
|---|---|
| `tools/c2js/jslex.mjs` | token scanner for the generated corpus — function definitions, call sites, import maps, local bindings |
| `tools/c2js/callgraph.mjs` | whole-program call graph over all 182 modules + the colouring fixpoint |
| `tools/c2js/color-census.mjs` | the report below |
| `tools/c2js/yieldify.mjs` | the transform (Phase 1) |

The graph is built from **the emitted JS**, not from the clang IR. Three
reasons: the emitted call sites are what the transform actually rewrites; the
hand-written runtime preludes that `build.mjs` inlines verbatim
(`tools/c2js/runtime/*-prelude.js`) exist only in the emitted output and would
be invisible to an IR-level analysis; and the colouring is a whole-program
fixpoint, which `emit.mjs` — one translation unit at a time — cannot compute.
The lexer's function-definition count agrees with `grep` on all 176 files.

### The seeds

The engine has **one** blocking leaf.

```
GLOBAL#getchar      js/boot/harness.mjs:791 — shift the input queue, else
                    park until a key arrives (interactive) / end the run (replay)
```

plus one *site* seed: `cptr.read(fileno(__stdinp), nestbuf, 1n)` inside
`tty_nhgetch` (wintty.js:2309), the nested-input path. `cptr.read` is
otherwise the ordinary file read used by save/restore and hacklib; seeding the
callee rather than the site falsely colours the entire save/restore subsystem
(`sfstruct.js` goes from 57% to 98% coloured), so the seed is matched at the
site.

Everything else that looks like it waits — `--More--`, menus, `getlin`,
`yn_function`, `getpos`, `wait_synch`, `tty_display_nhwindow`, `xwaitforspace`,
`dmore` — reaches the keyboard through that one call by way of `tty_nhgetch`,
and is therefore *found* by reverse reachability rather than asserted. Things
that look blocking and are not, checked individually:

- `tty_delay_output` — `NETHACK_NO_DELAY=1` takes the `fflush` branch, and the
  `ospeed` busy-loop never runs because the harness sets `ospeed = 0`.
- `g.sleep` / `g.usleep` — no-ops.
- `g.fgets` / `g.fgetc` / `g.getc` — read the VFS fd table; `__stdinp` carries
  no `__fd`, so they return EOF rather than parking.
- `tty_mark_synch` — `fflush` only.
- signals — `g.signal` is inert, `g.raise` returns 0.

### The result

```
fn-pointer mode            : any
modules scanned            : 182 (176 generated + 6 hand-written runtime)
function definitions       : 6785  (6613 in js/generated)
call sites (engine-visible): 276120
  direct                   : 274409
  through function pointers: 1711
address-taken functions    : 1121

COLOURED functions   : 4666 / 6785   (68.8%)
  in js/generated    : 4666 / 6613   (70.6%)
  hand-written rt    : 0     — js/cptr.js, js/cmachine.js, js/cjmp.js untouched
COLOURED call sites  : 33379 / 276120   (12.1%)
  direct             : 31668
  via function ptr   : 1711
coloured sites inside arrow closures : 0
top-level coloured call sites        : 0
```

**The two numbers are very different, and the second is the one that matters.**
69% of functions change shape, but only **12.1% of call sites** become
`yield*`. The gap is `cptr.*`: of 276,120 engine-visible call sites, roughly
three quarters are calls into the hand-written pointer/memory runtime
(`cptr.ldI32o`, `cptr.st1`, `cmachine.schar`), which never blocks and is
shared between the two builds unchanged. The overhead multiplier is 33,379
sites, not 276,120.

### Per-module, the top of the list

| module | funcs | coloured | col% | sites | coloured sites | % |
|---|---|---|---|---|---|---|
| trap.js | 124 | 100 | 80.6 | 6908 | 1297 | 18.8 |
| uhitm.js | 102 | 94 | 92.2 | 6177 | 1237 | 20.0 |
| zap.js | 85 | 63 | 74.1 | 5126 | 972 | 19.0 |
| apply.js | 76 | 55 | 72.4 | 4492 | 972 | 21.6 |
| options.js | 224 | 184 | 82.1 | 11100 | 823 | 7.4 |
| shk.js | 137 | 108 | 78.8 | 4594 | 815 | 17.7 |
| sp_lev.js | 142 | 103 | 72.5 | 5911 | 796 | 13.5 |
| objnam.js | 87 | 67 | 77.0 | 5672 | 665 | 11.7 |
| mon.js | 129 | 101 | 78.3 | 5177 | 658 | 12.7 |
| nhlsel.js | 33 | 33 | 100.0 | 823 | 256 | 31.1 |

The Lua interpreter is in the graph and is coloured where it should be
(`nhlua.js` 94.7%, `lparser.js` 80%, `lstrlib.js` 84.9%) — `nhl_pcall_handle`
runs level-generation scripts that call back into `pline`. No special handling
was needed: `lua_pcallk` and friends are ordinary C in the same fixpoint.

### The hot-path verdict

```
rng       rn2=clean  rnd=clean  rnl=clean  rne=clean  rnz=clean
          rn2_on_display_rng=clean
util      dist2=clean  sgn=clean  eos=clean
display   newsym=COLOURED  show_glyph=COLOURED  docrt=COLOURED
          flush_screen=COLOURED  map_location=COLOURED  back_to_glyph=COLOURED
vision    vision_recalc=COLOURED  view_from=COLOURED  do_clear_area=COLOURED
          clear_path=clean
monmove   movemon=COLOURED  dochug=COLOURED  m_move=COLOURED  mon_regen=COLOURED
mainloop  moveloop=COLOURED  domove=COLOURED  test_move=COLOURED  rhack=COLOURED
output    pline=COLOURED  putmesg=COLOURED  tty_putstr=COLOURED  more=COLOURED
```

**The RNG stays clean, the display and monster-movement recomputation do not.**
That is the correct answer and not a soft one: `newsym` reaches `pline` reaches
`tty_putstr` reaches `update_topl` reaches `more()` reaches `xwaitforspace`
reaches `tty_nhgetch`. Any display update can, in principle, overflow the
message window and stop for `--More--`.

That `rn2` is clean is not luck — see the next section.

### Function pointers: the decision that nearly cost the RNG

An indirect call `(cptr.ldPtro(windowprocs, 256))()` can land on any function
whose address was taken. Two ways to model it:

- **`--fptr=uniform`** — force every address-taken function to be a generator,
  so every indirect site is unconditionally `yield*`-safe with no runtime
  check. Costs 5044/6785 coloured (74.3%) and 45,764 coloured sites.
- **`--fptr=any`** — a pointer call is coloured iff *some* target is coloured;
  address-taken functions that stayed plain remain plain. 4666/6785 (68.8%),
  33,379 sites.

`uniform` is 19% more coloured call sites, which by itself is arguable. What
settles it is that **`uniform` turns `rn2` into a generator**. `rnd.c` stores
`rn2` and `rn2_on_display_rng` into `rnglist` so that `whichrng()` can
*compare* pointers:

```c
static int whichrng(int FDECL((*fn), (int))) {
    for (i = 0; i < 2; ++i) if (rnglist[i].fn == fn) return i;
```

The address is taken; the pointer is never called. Address-taken is not the
same relation as called-through, and confusing them costs the hottest function
in the engine. **`any` is the shipped mode.**

`any` then needs a runtime answer at the 1711 indirect sites, since the target
may or may not be a generator. `js/yield-rt.js`'s `icall` provides it: the
callee is evaluated once, and delegated to only if what came back is a
generator. Transpiled C returns numbers, BigInts, CPtr records `{buf, off}` or
null — never anything with `.next` and `.throw` — so the test is exact.

---

## Phase 1 — the mechanism

### Generators, not async/await

Chosen on argument, not on a bake-off, and the argument is short enough to
state:

- **Cost per call.** A generator call allocates one generator object and
  suspends synchronously. An `await` allocates a promise *and* schedules a
  microtask, on **every one of the 33,379 coloured sites** that executes —
  even when nothing is actually pending. Since a single keystroke can run tens
  of thousands of coloured calls, that is a microtask storm, not an overhead.
- **Determinism.** `yield*` delegation is synchronous. Control does not leave
  the engine between two coloured calls, so nothing can interleave. With
  `await`, the harness, the VFS overlay, the stdout marker parser and the
  page's own event handlers all become reentrancy hazards against a half-run
  keystroke.
- **The park is where the difference should live, and only there.** With
  generators, control returns to the event loop exactly once per keystroke —
  at the park — and the driver decides whether to answer synchronously or with
  a promise. That is a property of the *driver*, not of 33,379 call sites.

A/B'ing the two would have meant emitting and debugging a second full engine to
measure a difference whose sign was not in question. That budget went into
making the generator build byte-exact instead.

### The transform

`tools/c2js/yieldify.mjs` reads `js/generated/` and writes `js/generated-y/`:

- coloured definitions become `function*`;
- coloured calls become `(yield* f(...))`;
- indirect calls become `(yield* Y.icall(f(...)))`;
- the one stdin read becomes `(yield* Y.stdinRead(buf))`;
- a coloured function handed to hand-written runtime that calls it directly
  becomes `Y.drive(f)`.

```
files                 176
generators emitted    4666
direct calls wrapped  31667
fn-ptr calls wrapped  1711
stdin reads rewritten 1
Y.drive wraps         1
bytes 13,207,145 -> 13,587,232  (+2.9%)
--check: all 175 files parse (1 already unparseable in js/generated/ — see below)
```

`js/generated/isaac64.js` redeclares a symbol and has never parsed; it is a
transpiler-coverage artifact and nothing imports it (the frozen
`js/isaac64.js` is canonical). `--check` judges each output against its source
rather than absolutely, so a pre-existing condition is not reported as a
regression.

**Why a post-pass and not `C2JS_YIELD=1` inside `emit.mjs`.** The brief asked
for an emit mode; `build.mjs` honours `C2JS_YIELD=1` by invoking this, so the
interface is intact, but the work happens after emission for three reasons.
(1) The sync build is the scored build; a post-pass cannot alter it *by
construction*, so "byte-identical with the flag off" is a fact of the file
layout rather than a property to be tested. (2) `assemble()` inlines the
hand-written preludes verbatim and `emit.mjs` never sees them — `rnd.js`'s
prelude alone defines `getenv`, `fopen`, `panic`, `sgn`. (3) The colouring is a
whole-program fixpoint; `emit.mjs` has no cross-module view.

### `js/yield-rt.js` — four functions

| | |
|---|---|
| `KEY_REQUEST` | the sentinel a parked engine yields; identity is the protocol |
| `icall(r)` | delegate an indirect call only if the target turned out to be a generator |
| `drive(fn)` | adapt a generator back down to a plain synchronous function, throwing if it parks |
| `stdinRead(buf)` | the nested-input read inside `tty_nhgetch` |
| `trampoline(it, nextKey)` | run to completion; `nextKey` may return a key or a promise of one |
| `ResidentEngine` | park-per-keystroke: `start()`, `step(code)` |

### The harness

`js/boot/harness.mjs` is hand-written and on the scored path, so it is not
edited. `yieldify.mjs` generates `js/boot/harness-y.mjs` from it with **seven
textual patches, each asserted to match exactly once** — a silent miss would
produce a harness that boots the *sync* engine and reports a meaningless
parity pass. Two import redirects, the `main()` trampoline, and the lines that
turn `g.getchar` from a blocking call into a yielding one.

The one that matters:

```js
await Y.trampoline(um.main(1, argv), opts.residentKey || waitForKey);
```

`await` is legal here **precisely because `main` is a generator**: at a park
there is no live C stack, only suspended generator frames on the heap, so
control may leave for the event loop and come back. That single line is the
whole thesis of this leg.

During replay neither key source is set, the move string is queued up front,
`getchar` drains it without ever reaching its `yield`, and the trampoline loop
turns exactly once. **A corpus run therefore tests the transform and nothing
else** — no trampoline behaviour is mixed into the parity result.

### Three bugs that produced a wrong engine silently

Recorded because each is a general hazard, not a typo.

1. **`uniform` colouring destroys `rn2`.** Above.

2. **A function pointer in a parameter is a bare identifier call.** `getobj`
   takes `int (*obj_ok)(struct obj *)` and calls it as `obj_ok(otmp)` — which
   is lexically indistinguishable from a call to a module function. Unwrapped,
   it returned a *generator object*, `== GETOBJ_EXCLUDE` was false, and the
   engine answered "You can't wear that!" where C said "That is a silly thing
   to wear." — with a **byte-identical RNG log**. Nine such sites exist in the
   whole corpus (`obj_ok`×2, `buzzfn`×2, `f`×2, `allocf`, `wf`,
   `is_ok_location_func`) and they cost four sessions. The fix is a local-
   binding table per function: a call to a name bound as a parameter or
   `let`/`const`/`var` is a call through a pointer, not a direct call. The
   analysis over-collects deliberately — over-collecting reclassifies a call
   as indirect, which `icall` handles; under-collecting breaks the engine.

3. **Where a callee expression starts.** `cptr.ldPtro3(t, i, 24, 16)(a)` is one
   call; wrapping from the wrong token produced `cptr.ldPtro3` applied to
   nothing. `void (p)()` and `for (...) (p)()` then need *different* answers
   about whether the preceding parenthesised group is part of the callee — it
   is after a prefix operator, it is not after a statement head.

### Gotchas handled, and gotchas punted

**Handled:**

- **setjmp/longjmp.** `js/cjmp.js` throws a tagged `Longjmp` and catches it at
  the `setjmp` site. Exceptions propagate through `yield*` delegation
  unchanged, closing inner generators on the way out and running their
  `finally` blocks. No change was needed; the panic/savelife paths are
  exercised by the corpus (`seed0030-ten-diverse-deaths`, ten deaths).
- **The `__pc` state machines.** Goto-elimination emits `switch (__pc)` inside
  a labelled loop in 10+ modules (`getpos.js` has 158 of them). `yield*` inside
  a `switch` inside a loop inside a generator is ordinary; nothing special was
  required. Worth stating because the shape looks alarming.
- **The Lua interpreter.** In the graph, coloured by the same fixpoint, no
  special handling.
- **Recursion.** A recursive coloured function is a generator that `yield*`s
  itself. Depth costs one generator object per frame instead of one stack
  frame; the corpus's deepest recursion (`sp_lev` level generation, Lua's
  parser) runs byte-exact.
- **Hand-written runtime calling back into transpiled code.** Nine sites, one
  of which is real: `cptr.qsort` invoking its comparator. `Y.drive` wraps
  `nh_qsort_idx_cmp` and throws if it ever tries to park. The other eight are
  `cptr.postinc`/`postdec`'s getter/setter lambdas, which contain only `cptr`
  calls.
- **Arrow closures.** Zero coloured call sites land inside one, so no hoisting
  was needed. The transform refuses to emit if that ever stops being true.

**Punted, with reasons:**

- **`C2JS_FOLD_VERIFY` on the yield build: N/A.** The fold audit is an
  *emitter* audit — it re-runs `emit.mjs`'s expression emitters and evaluates
  the result to prove each constant fold reproduces C's value. The yield build
  is a rewrite of `emit.mjs`'s finished output and contains exactly the folds
  the sync build contains, unmodified. There is nothing new to audit. The
  standing result (301,692 folds, 0 mismatched, 0 unevaluable) is inherited.
- **`tools/strict-score.mjs` sandbox-parity has not been run on the yield
  build.** It walks the module graph from `js/jsmain.js` and would need to be
  pointed at `js/jsmain-yield.mjs`. Not a risk for the scored path, which is
  unchanged, but a prerequisite before anything ships.
- **Browser-side interactive plumbing** (`js/allmain.js`, `js/game_display.js`)
  has no generator variant. Only `runBootGame` is driven here. See Phase 2.
- **The `--fptr=uniform` mode is implemented but unused.** Kept because it is
  the honest alternative and the census reports it.

---

## Phase 1 — the numbers

Methodology: the standing one (`docs/NOTES-speed-stage1.md`,
`NOTES-speed-stage2.md`) — alternate runs in the same shell, never batch one
side then the other; best-of-N per session then summed; medians with the full
range; discard the cold first pair.

### Corpus parity — the acceptance bar

```
SESSION_REPLAY_TIMEOUT_MS=300000 node yieldtest/ps_test_runner.mjs sessions/ sessions-extra/
  69/69 passing      (run twice, clean)
```

`yieldtest/ps_test_runner.mjs` is a verbatim copy of `frozen/ps_test_runner.mjs`
with three path edits: the engine entry becomes `js/jsmain-yield.mjs`, and
`screen-decode.mjs` / `session_loader.mjs` are imported back out of `frozen/`.
**`frozen/` is not modified.** The comparison logic — RNG string equality plus
the 24×80 cell-grid screen and cursor comparison — is byte-for-byte the
scorer's own.

### The scoring path is untouched — proved, not asserted

```
node tools/c2js/build.mjs --all          # flag off, with every change present
  pass 2: emit in 15s — 169 ok, 1 failed, 2 skipped
  decls 10513/10627, functions 6508/6586, parse-failures 0
git status --short js/generated/          # (empty)
git diff --stat js/generated/             # (empty)

C2JS_YIELD=1 node tools/c2js/build.mjs --all
  ... yieldify -> js/generated-y (176 files)
git status --short js/generated/          # (empty)

node frozen/ps_test_runner.mjs seed8000 seed4500 seed0013-friday13
  3/3 passing
```

Two full rebuilds with the emitter changes present reproduce `js/generated/`
byte-for-byte, with the flag on and with it off. The only change to the
existing build is a hook at the bottom of `build.mjs` that runs *after*
`js/generated/` is final. (A first attempt at that hook chained `.then` onto a
non-promise and threw after a successful build; normalised with
`Promise.resolve` so the hook can never invent a failure it did not cause.)

### Replay speed — interleaved A/B, `sessions/` (44 sessions, 11,349 moves)

4 pairs, pair 1 discarded as cold. `node yieldtest/ab.mjs --pairs=4 sessions/`

| | sync | yield | delta |
|---|---|---|---|
| engine ms, best-of-N per session, summed | **60 859** | **68 446** | **+12.5%** |
| engine ms, median (range) | 61 709 (61 575 – 62 920) | 70 198 (68 888 – 71 521) | |
| wall ms, median (range) | 66 700 (66 559 – 68 081) | 75 448 (74 120 – 76 676) | |
| `startup_ms` (OLS fit), median (range) | 703.0 (688.8 – 708.8) | 766.4 (765.4 – 782.8) | **+9.0%** |
| `per_move_ms` (OLS fit), median (range) | 2.7551 (2.7119 – 2.7962) | 3.1505 (3.1027 – 3.3307) | **+14.4%** |
| passing | 44/44 ×3 | 44/44 ×3 | |

The distributions are fully disjoint on the primary measure: the slowest sync
run (62 920 ms) is faster than the fastest yield run (68 888 ms). This is a
real regression, not noise — as it should be. 33,379 generator allocations'
worth of real regression.

### Resident engine — the configuration that matters

`node yieldtest/resident.mjs`, `seed4500-knight-coverage`, 600 keys, 20
discarded as warm-up, 4 interleaved rounds, round 1 discarded.

Three configurations, the same measurement shape, identical work
(`stdout_bytes` 822 409 in every run):

| | ms/move mean | ms/move median | p95 | first frame ms |
|---|---|---|---|---|
| **sync engine, synchronous driver** (the control) | 1.135 / 1.187 / 1.227 → **1.187** | 0.195 | 2.23 – 2.54 | 663 / 687 / 689 → **687** |
| **yield engine, synchronous driver** | 1.387 / 1.393 / 1.415 → **1.393** | 0.222 | 3.20 – 3.40 | 718 / 750 / 761 → **750** |
| **yield engine, event-loop driver** | 1.362 / 1.441 / 1.442 → **1.441** | 0.226 | 3.23 – 3.50 | 722 / 727 / 775 → **727** |

There is no "sync engine, event-loop driver" row. That configuration is
exactly what the synchronous engine cannot do, and the reason `ReplayEngine`
exists.

Reading it: the mechanism costs **+17%** per move (1.187 → 1.393); returning to
the event loop between every keystroke costs a further **+3%** (1.393 → 1.441)
and is free at the median. First frame costs **+6 to +9%**, ~40–60 ms.

**Against the thing it would replace: 1.44 ms/move versus ~21 ms/move.**

### Memory

`node --expose-gc yieldtest/mem.mjs sessions/seed4500-knight-coverage.session.json`,
two rounds each, in-process.

| | sync | yield | delta |
|---|---|---|---|
| heap after run | 287.4 MB | 307.7 MB | **+20.3 MB (+7.1%)** |
| RSS after run | 496.7 – 509.3 MB | 508.4 – 518.1 MB | ~+2% |
| wall | 3006 / 3053 ms | 3572 / 3389 ms | ~+15% |

Caveat: the 20 ms peak sampler never fires during a synchronous replay,
because the engine never yields to the event loop — so "peak" is not measured
and is not reported. The end-of-run figures above are `gc()`-forced and are the
honest numbers.

The +20 MB is the module graph and the live generator objects, not a leak:
end-of-run heap equals after-first-segment heap in every run.

---

## Phase 2 — the browser rung

**Reached.** `js/boot/main-thread-engine.mjs` is a resident NetHack on the
browser main thread. It runs `js/generated-y/`, boots once, parks at its first
`getchar`, and costs one generator resume per keystroke. No worker, no
SharedArrayBuffer, no service worker, no blocking.

### Wiring

Four edits, all in the fallback's slot rather than as a fifth transport:

- `js/boot/frames.mjs` — the input-boundary frame reader, extracted from
  `engine-worker.mjs` so the two resident engines share one copy of a
  wire-format parser.
- `FallbackEngine` in `interactive.mjs` — chooses the main-thread engine if the
  tree has one and `ReplayEngine` if it does not. The choice is made at
  `start()`, not at construction, because "is there a yieldable build here" is
  answered by an `import()` that may fail, and because **a main-thread engine
  cannot be unloaded once started** — nothing may start one before the race has
  decided the fallback is going to run at all.
- `FALLBACK_MODES` — `_swapIn`'s guard was `old.mode !== 'replay'`; a
  main-thread engine is also a fallback and must also be upgradeable.
- `transportOverride()` gains `main`, for the bench.

A tree without `js/generated-y/` is bit-for-bit the old page: the `import()`
fails, the failure is swallowed, and `ReplayEngine` takes over. `js/generated-y/`
and `js/boot/harness-y.mjs` are build artifacts and are `.gitignore`d, so that
is the *default* state of a fresh checkout until `C2JS_YIELD=1` is run.

### Measured

`tools/judge-sim/playability.mjs`, headless Chrome, seed8000, 240 keys.
This machine was heavily contended; absolute values run ~2–3× the figures in
`NOTES-transport-ladder.md`. **Compare within this table, not across
documents** — every row here was taken in the same session.

| invocation | engine | first_frame_ms | ms/move | median | p95 | console |
|---|---|---|---|---|---|---|
| production | `xhr` | 1161 / 1424 | 6.85 / 7.01 | 3.2 / 3.0 | 14.2 / 15.6 | 0 |
| `--coi` | `sab` | 1413 / 1389 | 3.43 / 3.34 | 0.69 / 0.56 | 7.5 / 7.0 | 0 |
| `--sw-deny-dedicated` | `xhr-shared` | 1482 | 6.60 | 2.9 | 12.3 | 0 |
| `--judge-stub` | `xhr` | 1404 | 5.50 | 1.8 | 10.4 | 0 |
| `--transport=replay` *(control)* | `replay` | 1252 / 1475 | **21.80 / 20.37** | 0 | 0.1 | 0 |
| `--no-sw` | **`main`** | 1420 / 1374 / 1405 | **0.714 / 0.688 / 0.682** | 0.4 | 1.9 – 2.0 | 1 † |
| `--inert-sw` | **`main`** | 1378 / 1389 / 1122 | **0.660 / 0.661 / 0.734** | 0.4 | 1.7 – 2.1 | 0 |
| `--hang-sw` | **`main`** | 2089 | **0.690** | 0.4 | 1.8 | 0 |
| `--transport=main` | **`main`** | 1350 / 1374 / 1403 | **0.667 / 0.688 / 0.699** | 0.4 | 1.6 – 2.0 | 0 |

Control at HEAD, same machine, same session: `--no-sw` → `replay`,
first frame 1441 ms, **21.665 ms/move**, 1 console line.

† The single console line under `--no-sw` is **pre-existing and not ours**: it
is Chrome's uncatchable "A bad HTTP response code (404) was received when
fetching the script" from the service-worker registration against a mirror that
has no `js/sw.js`. It is reproduced verbatim by HEAD (see the control row). Worth
fixing on its own account — the judge fails an entry on any console line — but
it belongs to `--no-sw`, not to this rung.

Three readings:

1. **It replaces the fallback, by a factor of 30.** Every degraded mode that
   used to land on `replay` at ~21 ms/move now lands on `main` at ~0.68. The
   target was "well under 5 ms local"; this is under 1.
2. **It is the fastest engine in the table** — faster than `sab` (3.4) and
   `xhr` (6.9). That is not a surprise on reflection: it pays no thread hop, no
   `postMessage`, and none of the ~4 ms of Chrome service-worker dispatch that
   dominates the XHR transport's per-keystroke budget. The engine is 17% slower
   and the transport is 100% of the difference.
3. **Healthy transports still win, unchanged.** production → `xhr`, `--coi` →
   `sab`, `--sw-deny-dedicated` → `xhr-shared`, `--judge-stub` → `xhr`. The
   race is untouched when it has something to race.

First frame is comparable (1350–1420 against 1161–1482 for the transports).
`--hang-sw` costs ~200 ms more than HEAD's 1879 — see the next section.

### One real problem found, not fixed

**A main-thread engine's boot starves the transports' handshake.**

With `--transport-delay`, HEAD's replay fallback paints first and is then
upgraded to `xhr` at key 2 (delay 1500) or key 8 (delay 3000). With this rung
in the fallback slot, the upgrade never fires at any delay from 600 to 3000 ms.
Two causes, and both are real:

- The bench's 200 keys complete in ~150 ms at 0.7 ms/move, so there is
  frequently no window in which a delayed transport can arrive *and matter*.
  That half is benign — the swap is an optimisation and the thing it optimises
  away is already gone.
- Instantiating 13.6 MB of modules **on the main thread** blocks the event loop
  for hundreds of milliseconds, and the transports' `ready`/`probe` handling is
  main-thread message dispatch. A transport that starts while the fallback is
  mid-boot can time out against `READY_TIMEOUT_MS`/`PROBE_TIMEOUT_MS` for no
  reason but CPU. That half is not benign: it means this rung does not merely
  fail to win gracefully, it can *cause* a healthy transport to lose.

Production is not affected — the transports start at t=0 and the fallback at
t=700 ms, by which time the handshake is done, which is what the whole table
above shows. But `FALLBACK_HEAD_START_MS` was tuned for a fallback that boots
in a worker realm. A main-thread fallback needs either a longer head start, or
to be started only once the transports have definitively failed, or a yielding
boot. Deciding that is the first task of the next leg, and it is the reason
this is a "ship after one more leg" and not a "ship".

---

# Phase 3 — the leg that made it shippable

Phase 2 ended with one blocking defect ("A main-thread engine's boot starves
the transports' handshake"), one unanswered question (should this rung be the
*fallback* at all, when it measured faster than every transport?), and a build
that was not in the repository. This phase closes all three.

## The starvation problem, and what it actually was

The symptom was reported correctly and diagnosed incompletely. Under
`--transport-delay` the upgrade swap never fired at any delay from 600 to
3000 ms, and the reasoning was that instantiating 13.6 MB on the main thread
starves the transports' `ready`/`probe` message dispatch. That is a real
mechanism and it is fixed below — but it was not the biggest thing happening.

### The phantom boot

`FallbackEngine.start()` checked `this._dead` **after** `eng.start()` had
returned:

```js
const { MainThreadEngine } = await import('./main-thread-engine.mjs');
const eng = new MainThreadEngine(this.job);
const frame = await eng.start();          // <- 13.6 MB + a whole game
if (this._dead) { eng.retire(); return frame; }
```

`RacedEngine.start()` releases the fallback's head start the moment the
transports settle *either way* — `letFallbackRun()` is called on success as
well as on failure, immediately followed by `fallback.destroy()`. Destroy sets
`_dead`; the released `held.then(() => fallback.start())` runs one microtask
later; and `start()` then went ahead and fetched all 167 yield modules,
instantiated them in the page realm, booted a complete game and threw it away.

**On every healthy production page load.** The evidence was in the request log
the whole time:

```
node tools/judge-sim/playability.mjs --moves=240 --keep      (HEAD)
  engine transport : xhr
  ms/move          : 5.203   (median 1.8, p95 8.7, max 443.8)
  requests matching 'generated-y'  : 167
  requests matching '/js/generated/': 167
```

A page that won the race with `xhr` fetched **both** engine builds and ran a
443 ms keystroke in the middle of an otherwise 1.8 ms/move game. That single
443 ms keystroke is the main-thread boot, and the ~700 ms of blocked event loop
around it is what was starving the handshake. With the guard moved to where it
belongs — and a second check added between the import and the boot — the same
command gives:

```
  ms/move          : 3.336   (median 1.7, p95 8.8, max 65.8)
  requests matching 'generated-y'  : 0
```

This is also the explanation for a discrepancy Phase 2 recorded and attributed
to machine contention: production measured 2.44 ms/move in
`NOTES-transport-ladder.md` and 6.85 in the Phase 2 table. Some of that gap was
contention. Most of it was this.

**The general lesson, which is why it is written down rather than just fixed.**
A rung whose cancellation is free (terminate a worker) and a rung whose
cancellation is impossible (a module graph in the page realm) cannot share a
`start()` that checks for cancellation once, at the end. `FallbackEngine` now
checks `_dead` before the import, after the import, and — through a `cancelled`
predicate passed into `MainThreadEngine.start()` — between instantiating the
graph and booting the game. Three checks for three irreversible steps.

### Deadlines that stop counting while the thread is blocked

The second mechanism is real even with the phantom boot gone, because the
fallback *does* legitimately run in every degraded mode, and while it runs
nothing else in the page can.

Every timeout in the handshake is asking "has that realm had a fair chance to
answer yet?" and `setTimeout` answers "has that much wall-clock time passed?".
Those were the same question while everything expensive lived in a worker. They
are not the same question once the fallback is a main-thread engine: the
transport's `ready` message and the service worker's probe answer sit in the
task queue beside the overdue timer that is about to declare them missing, and
which one Chrome runs first decides the transport's fate.

`servicedTimeout()` in `js/boot/interactive.mjs` replaces the single
`setTimeout` with a 100 ms tick that credits at most 200 ms per tick. A tick
that arrives late is evidence the thread was blocked, not that the realm was
slow, so the remainder is written off and every deadline in flight is extended
by roughly the length of the block. It also guarantees the queued message is
drained before the deadline can be reached again, since a timer callback and a
message callback are the same kind of task. Cost when nothing is wrong: one
100 ms timer per outstanding deadline, of which there are at most three.

Applied to `READY_TIMEOUT_MS`, `PROBE_TIMEOUT_MS`, the warm wait, and the
service-worker activation wait.

### One seam in the boot, deliberately placed

`MainThreadEngine.start()` now has exactly one real task boundary
(`await new Promise(res => setTimeout(res, 0))` — a microtask would service no
message at all) between its two blocking halves: instantiate the graph, and run
`newgame()` to the first park. It is used for two things at once — ask the race
whether the second half is still wanted, and give everything queued behind the
first half a turn of the event loop.

The module graph is **not** chunked further. Splitting it into staged dynamic
imports would reorder module evaluation, and ESM evaluation order is a property
the emitted graph relies on; "faster boot" is not worth "a different boot".
`js/generated/**` is one statically-imported component by construction (see
`NOTES-transport-ladder.md`, "Not taken, and why"), and that has not changed.

### What the head start is, and why it stayed at 700 ms

The brief offered three shapes: a bounded exclusive window for the transports,
longer transport timeouts, or a chunked boot. The answer is that
`FALLBACK_HEAD_START_MS` **already is** the bounded exclusive window, and once
the phantom boot is gone it does its job: a healthy transport proves itself in
~100–300 ms, cancels the fallback before it has imported anything, and the page
realm is never touched. Lengthening it would only cost the degraded modes their
first frame, which is the budget that actually matters
(`--hang-sw` is the worst case and is already the slowest row in the table).

So: exclusive window unchanged, timeouts made stall-aware rather than longer,
boot given one seam rather than many.

### Measured: the upgrade swap, which never used to fire

`--transport-delay` holds the transports back so the fallback demonstrably wins
and the swap can be measured on purpose. Phase 2: "the upgrade never fires at
any delay from 600 to 3000 ms". Now, with `--key-delay=15` (below):

| delay | first frame | first painted by | ended as | swap at key | console |
|---|---|---|---|---|---|
| 600 ms | 2259 | `main` | `xhr` | 0 | 0 |
| 1500 ms | 2145 | `main` | `xhr` | 20 | 0 |
| 3000 ms | 1901 | `main` | `xhr` | 94 | 0 |

**`--key-delay` is new, and it is a fix to the measurement, not to the code.**
The other half of Phase 2's finding was "the bench's 200 keys complete in
~150 ms at 0.7 ms/move, so there is frequently no window in which a delayed
transport can arrive and matter". That is true and it is a property of the
*harness*: a bench that types as fast as frames arrive consumes 1200 keystrokes
in 590 ms, which is shorter than any transport takes to come up. Nothing about
the swap can be observed through it. `?keydelay=<ms>` in `index.html`'s bench
paces the keys the way a person does; the pause is excluded from `wall_ms`, so
`ms/move` is unaffected and comparable to every unpaced row.

## The rung-priority decision

### The measurements

Three rungs, interleaved in one session, 243 keys, seed 8000, pinned datetime,
four rounds with round 1 discarded as cold. `main` here is the main-thread
engine reached through `--transport=main`; `sab` needs `--coi` and is
unreachable in production; `xhr` is the production path.

**Unloaded** (`tools/judge-sim/playability.mjs`):

| rung | ms/move (median of 3) | range | median key | p95 | engine ms/move | start→frame |
|---|---|---|---|---|---|---|
| **main** | **0.700** | 0.637 – 0.828 | 0.4 | 1.9 | 0.616 | 608 |
| `sab` (`--coi`) | 1.368 | 1.145 – 1.690 | 0.61 | 6.0 | 0.645 | 605 |
| `xhr` (production) | 4.145 | 2.165 – 6.008 | 2.1 | 7.0 | 0.774 | 668 |

**Under machine-wide load** (`tools/judge-sim/loadgen.mjs --workers=6`, the
unbiased handicap — it contends for the same cores as every target in the
browser):

| rung | ms/move | range | median key | p95 | start→frame | first frame |
|---|---|---|---|---|---|---|
| **main** | **0.884** | 0.697 – 0.884 | 0.5 | 2.2 | 884 | 1642 |
| `sab` | 5.513 | 1.648 – 5.513 | 0.78 | 6.9 | 797 | 1450 |
| `xhr` | 10.277 | 7.059 – 10.277 | 4.1 | 38.0 | 802 | 1497 |

**Under a 4× page-target CPU throttle** (`--cpu-throttle=4`, the *biased*
handicap — Chrome's `Emulation` domain does not reach worker targets, so this
slows the main thread and leaves the transports' engines at full speed):

| rung | ms/move | median key | p95 | engine ms/move | start→frame |
|---|---|---|---|---|---|
| **main** | **4.412** | 2.9 | 9.1 | 3.882 | 2578 |
| `sab` | 17.267 | 15.75 | 25.6 | 0.935 | 589 |
| `xhr` | 18.077 | 15.9 | 24.7 | 0.916 | 681 |

Three things to read out of these.

1. **The main-thread engine is the fastest rung in every regime**, by 2× over
   `sab` and 6× over `xhr` unloaded, and by 6×/12× under contention. Phase 2's
   result holds under clean repeated measurement.
2. **It is the rung contention hurts least**, which is the opposite of the
   intuition. Its per-key cost is engine work and nothing else; the transports'
   is engine work *plus* a thread hop and (for `xhr`) Chrome's service-worker
   dispatch, and those are precisely what a busy machine makes expensive. Under
   load `xhr` went 4.1 → 10.3 and its p95 went 7 → 38; `main` went 0.70 → 0.88.
3. **The 4× column is the honest counter-evidence** and is reported because it
   is the one measurement that goes the other way: the main-thread engine's
   *first frame* is on the throttled thread (start→frame 608 → 2578) while the
   transports boot in an unthrottled worker (605 → 589). That comparison is
   rigged in the transports' favour — a genuinely slower machine slows the
   worker too, which is what the loadgen table shows — but the underlying point
   is real: this rung's boot cost lands on the thread the page is drawn on, and
   every other rung's does not.

### The call: it stays in the fallback slot

**Not promoted.** The speed case is strong and it did not decide this. Four
things did, in order.

1. **Download.** Promotion makes a healthy page fetch a build it does not
   fetch today. Keep the transports as the multi-game and upgrade path and the
   page carries **both** graphs — 26.8 MB of JS instead of 13.2 — because the
   transports' realm imports `js/generated/**` and the page realm imports
   `js/generated-y/**`. Drop the transports for game 1 and the page carries one
   graph but loses the prewarm, the upgrade path and the service worker that
   game 2 needs. The fallback slot is the only arrangement in which **nobody
   fetches a build they are not going to run**: healthy pages fetch the sync
   build, degraded pages fetch the yield build, and no page fetches both. The
   judge simulator cannot price this — it is loopback, and at `--latency=10`
   the whole 167-module fetch costs 44 ms — but a real player on a real
   connection pays it in seconds.
2. **One game per page, against a page shape we cannot observe.** The C arena
   is global and a page realm's module graph cannot be unloaded, so this rung
   spends the realm it plays in. If the judge's browser check really drives 88
   sessions through one page, promotion makes session 1 fast and sessions 2–88
   land on transports that were never prewarmed. If it loads a page per
   session, promotion is a clear win. The fallback slot is the choice that is
   correct under *both* readings; promotion is the choice that is clearly
   correct under one of them and is a gamble on which.
3. **Where to put the risk.** The transports run `js/generated/**` — the build
   the judge has scored 44/44. The main-thread rung runs `js/generated-y/**`,
   which is 69/69 byte-exact twice on the scorer's own comparison and has never
   been judged. Phase 1 produced three separate silently-wrong engines in one
   day. Put a new engine where the alternative is 21 ms/move (all upside) and
   not where the alternative is a proven 2–4 ms/move.
4. **UI jank is a real cost and it is only paid by promotion.** The boot blocks
   the page's event loop for ~600 ms unloaded and ~2.5 s at 4× — no repaint, no
   scrolling, no response to a human typing during boot. A transport's boot
   leaves the page live. In the fallback slot that cost is paid only where the
   alternative was a fallback that blocked the page anyway.

**What would change the answer**, recorded so the next leg does not have to
re-derive it: a judged run showing the browser check is per-page rather than
per-session, or a bandwidth-priced first-frame measurement showing the extra
13.6 MB costs less than the 12× per-keystroke win under contention. The second
table above is the strongest argument for promotion that exists, and it is not
answered by anything except the download and the never-been-judged-ness.

### Two consequences of *not* promoting

- **The degradation banner is not shown for `main`.** `warnDegradedEngine()`
  says "falling back to checkpoint replay: correct, but the screen lags behind
  your keys" — true of `replay` and a lie about a rung that answers a keystroke
  faster than any transport in the file. `RacedEngine` now raises it only when
  the fallback that won is `replay`.
- **The upgrade swap is kept anyway**, and is documented as unreachable in
  production. A transport that arrives after `main` has painted is *slower*
  than what it replaces, so on the numbers alone the swap should be declined.
  It is kept for two reasons: it is the insurance if the yieldable engine ever
  mis-steps in a way the corpus does not cover, and in production it cannot
  fire at all — the transports settle in ~300 ms, inside the 700 ms head start,
  so the main rung never starts in the first place. The only way to reach it is
  `--transport-delay`, which is test-only, and there it is the evidence that the
  handshake survived the boot.

## The full mode table, at this tree

`tools/judge-sim/playability.mjs`, Chrome 151 headless, `judge-sim` mirror
server, seed 8000, 243 keys, pinned `--datetime`, three rounds per mode in one
sitting. **This machine carried a load average of 6–10 on 10 cores throughout,
from other people's applications**, so the transport rows are noisy in a way the
main rows are not — the range is given for every one of them and the best of
three is the least contaminated view. Compare within this table.

| invocation | engine | first frame | start→frame | ms/move (best / range) | median key | p95 | engine ms/move | console |
|---|---|---|---|---|---|---|---|---|
| production | `xhr` | 1437–1453 | 622–738 | **2.879** / 2.9–19.8 | 1.9 | 7.0 | 0.75 | 0 |
| `--coi` | `sab` | 1402–1491 | 622–666 | **0.962** / 1.0–1.6 | 0.52 | 3.6 | 0.59 | 0 |
| `--transport=sharedworker` | `xhr-shared` | 1388–1498 | 593–774 | **2.309** / 2.3–11.9 | 1.5 | 4.8 | 0.66 | 0 |
| `--sw-deny-dedicated` | `xhr-shared` | 1411–1521 | 589–731 | **2.234** / 2.2–7.9 | 1.5 | 5.2 | 0.67 | 0 |
| `--judge-stub` | `xhr` | 1301–1460 | 610–713 | **2.395** / 2.4–17.0 | 1.5 | 6.1 | 0.66 | 0 |
| `--inert-sw` | **`main`** | 1394–1471 | 593–746 | **0.665** / 0.67–0.77 | 0.4 | 1.8 | 0.60 | 0 |
| `--no-sw` | **`main`** | 1360–1392 | 595–758 | **0.655** / 0.66–0.76 | 0.3 | 1.7 | 0.59 | 1 † |
| `--hang-sw` | **`main`** | 2090–2204 | 1285–1423 | **0.680** / 0.68–0.76 | 0.4 | 1.7 | 0.61 | 0 |
| `--transport=main` | **`main`** | 1359–1740 | 560–762 | **0.713** / 0.71–0.73 | 0.4 | 1.8 | 0.63 | 0 |

Every row: 243 keys consumed, `gameover: false`, 0 out-of-scope requests, a
status line showing a real character in the dungeon.

† `--no-sw`'s single line is the browser's own uncatchable *"A bad HTTP response
code (404) was received when fetching the script"* against a mirror with no
`js/sw.js`. Pre-existing, reproduced verbatim by HEAD, and unreachable on a
correctly published mirror. Documented in `NOTES-transport-ladder.md`.

**The spread is the most interesting column.** Four of the five transport rows
have a worst round 3–8× their best (`xhr` 2.9 → 19.8, `xhr-shared` 2.3 → 11.9,
`--judge-stub` 2.4 → 17.0); the four `main` rows span 0.655–0.767 across
*twelve* runs. A rung whose per-key cost is engine work and nothing else has
nothing for a busy machine to interfere with; a rung that pays a thread hop and
a service-worker dispatch has two.

`--hang-sw` is the only mode where the main rung's first frame is over 2 s
(2090–2204, start→frame 1285–1423), and it is over 2 s for the reason it always
was: the transports are still being waited on. It is inside the 2.5 s budget.

## The prewarm, composed

`prewarmEngine()` warms a *worker* realm: the transport race, then
`{type:'warm'}` to whichever realm won. That is unchanged on any page that has
a transport, and it must be — warming the main-thread rung beside a transport
would put 13.6 MB in the page realm for an engine that is not going to play.

What is new is the other branch. A prewarm whose transports fail has learned
something that does not change inside one page's lifetime, and the rung this
page is really going to play on is the main-thread engine. So the failure path
now calls `warmMainThreadRung()`, which imports `js/boot/harness-y.mjs` and
therefore the whole yieldable graph, in the page realm, running no C code. It
is job-independent for exactly the reason the worker warm is — no generated
module reads a harness global at module scope — and a boot that arrives later
joins the import in flight rather than repeating it (`graph` in
`main-thread-engine.mjs` is the same promise).

### And it is worth much less than the worker prewarm, which is the interesting part

`MainThreadEngine` now reports its boot split (`main_graph_ms` /
`main_boot_ms` in the bench report), because the question "is warming this
graph worth anything?" is exactly the ratio between them:

Two-phase runs (`--part2=2000 --seed2=4500`, the judge's shape: load the page,
leave it alone for two seconds, then build a `NethackGame` with a seed the page
never picked), three rounds, medians:

| | rung | start→frame | prewarm | graph |
|---|---|---|---|---|
| `--part2=2000` | `xhr` | **383** (379/383/391) | adopted, warm | — |
| `--part2=2000 --no-prewarm` | `xhr` | 712 (662/712/786) | none | — |
| `--part2=2000 --transport=main` | `main` | **597** (588/597/736) | adopted, warm | 0 ms |
| `--part2=2000 --transport=main --no-prewarm` | `main` | 687 (610/687/763) | none | 9–18 ms |

and the same main-thread pair with every request delayed 10 ms (`--latency=10`),
which is the only way this harness can price a fetch at all:

| | start→frame | graph |
|---|---|---|
| warm | 947 (920/947/1097) | **0 ms** |
| cold | 1036 (1018/1036/1037) | **44 ms** |

**Instantiating 13.6 MB of yieldable engine in Chrome costs 9–18 ms**, and
44 ms when every one of its 167 requests is delayed by 10 ms. Not the ~480 ms the
Node `--cpu-prof` profile in `NOTES-transport-ladder.md` predicted — that
figure is real for Node, where the whole file is parsed on import, and wrong
for a browser, where function bodies are compiled lazily and the cost is billed
later, inside `newgame()`, where it belongs.

Which reframes what the *worker* prewarm was ever doing. Its measured win is
**329 ms** (`start→frame` 383 warm against 712 cold, above), against the main
rung's **90 ms** — and almost none of either is the graph: it is the service-worker registration, the worker spawn, the
interception probe and the message round trip — a handshake the main-thread
rung does not have. **A rung with no handshake has almost nothing to prewarm.**

The main-thread warm is kept because it is strictly positive (10–45 ms
measured), because it costs nothing on any page that has a transport (it cannot
run there), and because the part it saves — the fetch — is the part this
harness prices at zero and a real mirror does not. It is not, and is not
claimed to be, the win the worker prewarm is.

## Multi-game: what happens after the realm is spent

The main-thread rung spends the page realm. Three things had to be true and one
of them was not.

**`globalThis.__c2jsEngineRealmUsed` is now set by `MainThreadEngine`.** It is
the flag `js/jsmain.js`'s `runSegment` already keeps, and it is shared with the
main-thread rung deliberately even though the two engines spend *different*
module graphs (`js/generated/` and `js/generated-y/`). The graphs are separate;
the hand-written runtime under them is not. `js/cptr.js` holds the VFS fd
table, the pointer registry and the format cache, and both graphs import the
same instance of it. One flag, one meaning: transpiled C has run in this realm.

**`ReplayEngine`'s last-resort in-page boot now refuses instead of corrupting.**
When a realm can neither fork its module map (Node's `registerHooks`) nor spawn
one (a Worker), `ReplayEngine._boot` fell back to importing `harness.mjs` in the
page realm — which is correct exactly once, as its own comment said, and
produces `init_blstats called more than once` and a null-cptr throw every time
after. It now checks the same flag and throws a `TransportUnavailable` that says
what happened and what to do:

> this page realm has already run a game and cannot host another: no Worker to
> make a fresh realm in, and no module-map isolation. Reload the page to play
> again.

That is the existing spent-realm contract, extended to the one path that did
not keep it. It is strictly better than before this branch, too: the
pre-existing behaviour in a workerless page was a first replay that worked and
every replay after it producing garbage.

**`tools/judge-sim/multigame-repro.html`** is the new evidence. Measured, two
games in one page with no reload, same `--datetime`, seeds 8000 then 4500:

| page | game 1 | game 2 | console |
|---|---|---|---|
| default (workers, service worker) | `xhr`, 12 moves | `xhr`, 12 moves | 0 |
| `--no-sw` | **`main`**, 12 moves | `replay`, 12 moves | 1 † |
| `--transport=main` | **`main`**, 12 moves | `replay`, 12 moves | 0 |
| `--workerless` (3 games) | **`main`**, 12 moves | *refused, in words* | 0 |

Every row's two games show *different* characters on the status line
(`St:18/01 Dx:15 …` against `St:18/02 Dx:9 …`), which is the thing being
checked: game 2 is a new game, not a continuation of game 1's arena. The
workerless row's game 2 and game 3 both answer

> this page realm has already run a game and cannot host another: no Worker to
> make a fresh realm in, and no module-map isolation. Reload the page to play
> again.

with nothing on the console. Before this leg that page could not host game 1
at all.

†  `--no-sw`'s pre-existing browser-emitted 404 on `js/sw.js`. Nothing in the
repo could stage two *interactive* games in one page — `index.html` plays one
and its "play again" is a `location.reload()` — so the game-2 contract was
argued rather than tested. `playability.mjs --multigame` drives it and asserts
the three outcomes that are acceptable (a fresh worker transport, a
ReplayEngine realm, or a refusal in words) and the one that is not (a game 2
whose mode is `main`, i.e. hosted by the arena game 1 left behind).

## Build and CI

`js/generated-y/**` (176 files) and `js/boot/harness-y.mjs` are **committed**,
like `js/generated/**`. They were `.gitignore`d, and Phase 2's claim that "a
tree without `js/generated-y/` is bit-for-bit the old page" is true of its
*behaviour* and false of the thing that decides a run:

```
node tools/judge-sim/playability.mjs --transport-delay=1500     (generated-y removed)
  === Browser console (CDP: Log + Runtime, all targets) ===
    2 entries
      [page] log/network/error: Failed to load resource: 404 <.../js/generated-y/unixmain.js>
      [page] log/network/error: Failed to load resource: 404 <.../js/generated-y/rnd.js>
```

The import failure is swallowed and the page degrades correctly — and logs two
console lines doing it, which fails the judge's browser check on its own. There
is no way to ask a browser whether a URL exists without a 404 being logged if
it does not (the same fact that makes `--no-sw`'s single line unavoidable), so
the only fix is for the files to be there. They ship under `js/**` with
everything else.

Regenerate with:

```
C2JS_YIELD=1 node tools/c2js/build.mjs --all
```

which rebuilds `js/generated/` exactly as it always did and then runs
`tools/c2js/yieldify.mjs --check` over the result. `yieldify.mjs` can also be
run on its own (12 s) when `js/generated/` is already current:

```
node tools/c2js/yieldify.mjs --check
```

`.github/workflows/score.yml` is unchanged. `tools/strict-score.mjs` now walks
two roots instead of one — `js/jsmain.js` and `js/boot/main-thread-engine.mjs`
— so the 13.6 MB of machine-written JS the browser rung ships is held to the
same rule as the scored build, and reports how many of its files it walked so
that a tree which has not built it gets a note rather than a false pass.

---

# Phase 4 — the Node rung

**Reached.** The yieldable engine now runs in Node, in the fallback slot, and it
is what a `node --permission` sandbox gets when it is not allowed a worker
thread.

## The measurement that started it

`frozen/playability_runner.mjs` imports `js/jsmain.js`, builds a `NethackGame`
per session and drives `moveloop_core()` one key at a time. Run it the way the
judge's box runs it and the numbers are not the numbers we had been quoting:

```
node --permission --allow-fs-read="$PWD/*" \
  frozen/playability_runner.mjs sessions/seed8000-tourist-starter.session.json
  → 22 moves in 4192 ms (190.55 ms/move)
```

`--permission` denies worker threads. `Port.spawn('node')` therefore throws
`ERR_ACCESS_DENIED`, `_prepare()` turns that into `TransportUnavailable`, and
`startEngine()`'s Node branch had exactly one thing left to try: `ReplayEngine`,
which re-runs the whole key prefix from a fresh module graph. 190 ms/move is
that, and it is a *floor*, not a spike — the judge's box is slower, and the
~3.2 s of patience their playability check gives a session would not have
finished the first one. "0 moves in 88 sessions" is what that looks like from
outside.

The rung that fixes it was already in the tree, browser-gated. Phase 2's engine
needs no thread that can block, so nothing a sandbox denies is in its way.

## Wiring: three rungs in Node, in the same order as the browser's

`startEngine()`'s `IS_NODE` branch used to be transport-or-replay. It now falls
into `FallbackEngine` — the same object the browser race puts in the fallback
slot, holding the same two rungs in the same order — with `auto` false, so it
goes straight to `MainThreadEngine` and reaches `ReplayEngine` only if that
fails:

| rung | when | cost |
|---|---|---|
| `sab` (worker_threads + `Atomics.wait`) | unsandboxed Node | ~2.6 ms/move marginal |
| `main` (yieldable, in-process trampoline) | `--permission`, no worker | ~2-4 ms/move marginal |
| `replay` | neither | ~190 ms/move |

Preference, not capability: the transport is still tried first and still wins
when the sandbox allows it. The degradation banner is unchanged too — it fires
on `mode === 'replay'` and not on `main`, because a resident engine is not a
degradation to warn a player about.

## Isolation, composed

The browser rung can host **one** game per realm, and says so in `claimed`. The
playability runner plays 44 in one process. Those two facts are only compatible
because the one-game rule is a property of *sharing a graph*, not of running on
the main thread — and Node can stop sharing.

`MainThreadEngine.start()` now asks `forkGraph()` first. In Node that is
`js/boot/isolation.mjs`'s resolve hook, the same in-process graph fork
`runSegment` uses: `import(harness-y.mjs + '?c2jsseg=yN')` pulls a private copy
of all 176 generated modules plus the hand-written runtime under them, so game N
starts from static initialisers and not from game N−1's dungeon. When there is a
fork, `claimed` and `globalThis.__c2jsEngineRealmUsed` are *not* set: this game
spent nothing the realm owns. In a browser `forkGraph()` is not even called —
the `IS_NODE ?` test is synchronous, so the second game's refusal still happens
in the same microtask it always did.

Two details that had to be right:

- **The tag namespace.** `yN`, not `N`. The hook copies whatever follows
  `?c2jsseg=` verbatim, so the tag is a namespace, and `runSegment` is already
  using the integers. `js/generated/` and `js/generated-y/` would not collide on
  their own — but `js/cptr.js` is under both, and `cptr.js?c2jsseg=1` is *one*
  module whichever graph asked for it. A scored segment 1 and an interactive
  game 1 in one process would have shared the fd table and the pointer registry.
- **Silence.** `enableSegmentIsolation()` prints a degradation notice when
  `module.registerHooks` is missing, and the interactive path may not print
  anything. It now takes `{ quiet: true }` — which suppresses the notice *for
  that caller* and remembers the reason, so a later scoring caller still hears
  it. `ReplayEngine._boot` asks quietly for the same reason.

## `SHARED` had stopped matching anything

`isolation.mjs` excludes the vendored playground from forking, because
duplicating 2.1 MB of immutable data per graph is pointless parse and heap. The
pattern was `/\/data\/nethackdir\//`, and the playground moved to
`js/data-nethackdir/` when the mirror turned out to publish only `js/**` +
`frozen/**`. It has matched nothing since, on the scoring path as well as this
one. Measured, four forks:

| | per fork, heap | graph instantiation |
|---|---|---|
| pattern as it was | 54.2 MB | ~520-710 ms |
| pattern fixed | 49.8 MB | ~440-500 ms |

Sharing is safe rather than merely intended: the single consumer,
`js/boot/harness.mjs:172`, does `readVendored(v).slice()`, so the VFS gets a
copy and every write goes to the per-run overlay.

## What it costs, and the ceiling it has

Per-session, sandboxed, against the same runner in the same sandbox:

| | before (replay) | after (yield rung) |
|---|---|---|
| `seed8000-tourist-starter` (22 moves) | 4192 ms — 190.55 ms/move | 931 ms — 42.33 ms/move |

Almost all of what is left is boot, not play. Split out (`--expose-gc`, forced
gc between sessions, first eight sessions of `sessions/`):

```
seed0002 (594 moves)  boot 596 ms   play 1173 ms  (1.97 ms/move)
seed0004 (408 moves)  boot 484 ms   play  855 ms  (2.10 ms/move)
seed0007 (301 moves)  boot 468 ms   play 1060 ms  (3.52 ms/move)
seed0012 (307 moves)  boot 496 ms   play  908 ms  (2.96 ms/move)
```

The marginal cost is 2-4 ms/move, which is what a resident engine should cost
and is comparable to the worker transport's. Boot is ~500 ms of module
instantiation plus ~150 ms of `newgame()`, per session, and it is the aggregate.

**And it grows.** A forked graph can never be unloaded: Node's module map keys
on the URL and has no eviction, so every game a process plays leaves ~50 MB of
graph plus ~30 MB of spent arena behind it. By session 20 the heap is ~1.6 GB
and *boot* has gone from 580 ms to 1600 ms — the play cost is unchanged, but
each fork's 50 MB allocation now drags a major GC over a 1.6 GB live set:

```
session  1   boot  581 ms   heap  160 MB
session 10   boot  951 ms   heap 1156 MB
session 20   boot 1606 ms   heap 1615 MB
session 21   boot 94.6 s
session 22   boot  354 s
```

Aggregated the way the runner aggregates, over the same trace (16 GB machine):

| sessions played in one process | boot/move | play/move | ms/move |
|---|---|---|---|
| first 10 | 3.00 | 3.61 | **6.61** |
| first 20 | 6.29 | 3.89 | **10.18** |
| 21 and beyond | — | — | collapses |

Through session 20 the `play/move` column is flat: the engine is not what
degrades, the whole movement is boot, and the whole of boot is a fresh
176-module graph allocated against a heap that keeps growing. Past that point
the distinction stops being useful — session 22 recorded 354 s of graph
instantiation *and* 2037 ms/move of play, which is not V8 any more but the OS
paging a 1.7 GB heap on a machine that has run out of room. Both halves go. Ten sessions in one process is right beside
the worker transport's own aggregate on the same corpus (6.46 ms/move,
unsandboxed, measured before this machine's memory got tight); twenty is 1.6x
that; twenty-two does not finish. **The full 44-session sandboxed aggregate is
therefore not a number this branch can report** — the run does not complete on
a 16 GB machine, and the reason is above.

`releaseForkedGraph()` in `main-thread-engine.mjs` gives back what it can when a
game ends — `js/cptr.js`'s pointer table (append-only by construction, so it
pins every monster, object and temporary the game ever stored through a pointer
field) and the RNG log nothing interactive reads. Measured over eight sessions,
that is ~110 MB retained per game before and ~80 MB after. It moves the wall; it
does not remove it.

The wall is structural and it is not this rung's fault. A `--permission`
sandbox offers no disposable realm — no worker to terminate, no child to exit —
so in-process graph forking is the *only* per-game freshness available, and its
cost is quadratic in one process. Note that `frozen/ps_test_runner.mjs`, the
scoring runner, does not have this problem for a reason worth knowing: it
`spawnSync`s a child per session, so it never holds two graphs at once.
`frozen/playability_runner.mjs` does not.

## What happens at the wall, which is the part that had to be chosen

Left alone, a process that keeps forking meets V8's heap limit (4192 MB here)
and aborts. An out-of-memory abort mid-corpus takes every result the driver had
already collected with it, which is a worse answer than any answer — and the
rung *below* would make it arrive sooner, because `ReplayEngine` forks a graph
per replay rather than per game.

So `roomForAnotherGraph()` asks `node:v8` before each fork after the first, and
a game that would not fit is refused rather than attempted:

> this process has played N games and has no room for another: a forked module
> graph cannot be unloaded, and the heap is within X MB of its 4192 MB limit
> (node --permission allows no worker or child realm to play in instead). Play
> fewer games per process.

`RealmExhausted` is passed through `FallbackEngine` rather than degraded around
— it is the process being full, not a rung failing — so it reaches the driver,
which records that session as a failure and goes on. It is the same contract
`ReplayEngine`'s spent-realm branch already keeps in a browser ("this page realm
has already run a game and cannot host another... Reload the page to play
again"), in the shape Node can act on.

It is a floor, not a fix. The fix is a disposable realm per game, and the two
that exist are both outside this tree: a sandbox that allows `--allow-worker`,
or a playability runner that forks per session the way the scoring runner
already does.

---

## Verdict

**Ship, as a fallback replacement.** Not as the primary rung, and not as the
scoring engine, ever.

The case for:

- **Parity is not in question.** 69/69 byte-exact, twice, on the scorer's own
  comparison, with the RNG log matching call-for-call on all 61,892 moves.
- **The cost is small and lands in the right place.** +12.5% engine time on
  replay, +17% per move resident, +7% heap. The RNG stays a plain function; the
  hot integer utilities stay plain functions; only 12.1% of call sites change.
- **It is 30× better than what it replaces, measured in Chrome.** 0.68 ms/move
  against 21. Every degraded mode that used to land on `replay` now lands on
  `main`, first frame is comparable, and console output is unchanged. Healthy
  transports still win.
- **It removes the ladder's worst failure mode.** A transport that is trusted
  wrongly does not fail, it hangs inside `getchar()` forever. A main-thread
  engine has nothing to trust — no service worker, no SAB, no realm to spawn.
  It cannot hang waiting for a key because it does not wait.
- **The transform is mechanical and auditable.** One tool, 176 files, a
  pre-flight that refuses to emit when its four soundness properties do not
  hold, and a `--check` that judges every output against its source.

The case against, honestly:

- **It doubles the shipped engine.** 13.6 MB more JS in the tree and in any
  deployment that carries both builds. For a browser rung that is a real
  download cost and needs measuring before it ships.
- **Three silent-wrong-engine bugs in one day.** Every one produced a
  *plausible* engine — the second produced a byte-identical RNG log and a
  different message. The analysis is only as good as its model of what a call
  site is, and that model was wrong three times. The pre-flight now checks four
  properties; there is no argument that four is the right number.
- **The rung starves the transports' handshake while it boots.** Documented
  above. Production is unaffected, but the head start was tuned for a fallback
  that boots in a worker, and a main-thread fallback can make a healthy
  transport time out for no reason but CPU. This must be fixed before it ships,
  and it is the single reason the verdict is not simply "ship".
- **It can only ever host one game per page**, because C file-scope state is
  global and a page realm's module graph cannot be unloaded. Fine for a game
  the player plays once; not fine for the judge's Session Viewer, which runs
  many sessions through one page. `MainThreadEngine` enforces it and the second
  game falls back to `ReplayEngine`.

What the next leg must do, in order: (1) fix the boot-starvation interaction —
longer head start, start-after-transports-fail, or a boot that yields; (2)
`tools/strict-score.mjs` against `js/jsmain-yield.mjs`; (3) a download-size
decision, since shipping both builds is the actual cost, and the browser rung
means a real user downloads 13.6 MB more; (4) decide whether this should stay a
*fallback* at all — it measured faster than every transport, and if that holds
across browsers the ladder's whole shape is wrong; (5) re-run this census after
any transpiler change, because the colouring is a property of the emitted
output and will drift.

Abandoning would be wrong: this is the only route to a resident engine on a
plain static host with no COOP/COEP and no service worker, and it works.
