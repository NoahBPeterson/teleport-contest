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

**Not reached in this leg.** The design is settled and the mechanism is proved
end-to-end in Node (`yieldtest/resident.mjs` is a resident engine driven purely
from the event loop, which is the browser configuration minus Chrome), but the
rung itself — registration in `js/boot/interactive.mjs`'s race, silence and
timeout-bounding, `--noworker` in `tools/judge-sim/playability.mjs` — is not
written. What the numbers above predict, and what a next leg would verify:

- **ms/move.** 1.44 ms in Node, engine-only. A main-thread rung pays no worker
  message hop and no service-worker round trip — the ~4 ms of Chrome SW
  dispatch that dominates the XHR transport's per-keystroke budget simply is
  not there. It does pay DOM paint, which the XHR transport pays too. Expect
  **~2–3 ms/move**, i.e. between the SAB transport (1.2) and the XHR transport
  (2.4), and roughly **7–10× better than the 21 ms replay fallback** it would
  displace. Comfortably inside the judge's 5 ms bar even after the judge box's
  ~2.6× penalty is applied to the engine share.
- **first_frame_ms.** +6–9% over cold boot, so ~1.1–1.3 s local against the
  measured 1.0–1.9 s, and the prewarm applies unchanged (a warm main-thread
  realm is *more* natural than a warm worker — there is no realm to spawn).

Where it goes, precisely (from the recon in `docs/NOTES-transport-ladder.md`
and `js/boot/interactive.mjs`):

1. A third racer in `RacedEngine.start()` (~line 1099), alongside `transportP`
   and `fallbackP`, with its own smaller head-start gate — so its ordering
   against `ReplayEngine` is a time constant rather than a list position. It
   must be registered *outside* the `keyServiceOnce()` gate at line 923, which
   throws before the `modes` array is built when there is no service worker —
   exactly the hosts where a main-thread engine is the only thing left standing.
2. `_swapIn()`'s guard at line 1231 (`old.mode !== 'replay'`) must become a
   set, or a main-thread engine once adopted could never be upgraded to a real
   transport.
3. `transportOverride()`'s whitelist at line 144.
4. `--noworker` in `playability.mjs`, cribbed from `driver.html:22–29`, with
   the `Worker` poison landing **before** the prewarm IIFE at `index.html:55`.
   That is the right bench: with `Worker` unavailable, `Port.spawn` and
   `replayInFreshRealm` both fail into their `try/catch`, and the main-thread
   rung is the only engine left.

Every one of those has an obligation to be silent — the judge fails an entry on
any console line — and to be timeout-bounded rather than error-bounded.

---

## Verdict

**Ship as a fallback replacement — after one more leg.** Not as the scoring
engine, ever.

The case for:

- **Parity is not in question.** 69/69 byte-exact, twice, on the scorer's own
  comparison, with the RNG log matching call-for-call on all 61,892 moves.
- **The cost is small and lands in the right place.** +12.5% engine time on
  replay, +17% per move resident, +7% heap. The RNG stays a plain function; the
  hot integer utilities stay plain functions; only 12.1% of call sites change.
- **It is 7–10× better than what it replaces.** The rung it would displace
  costs ~21 ms/move. Nothing else about the ladder changes: SAB and XHR still
  win when available, and `_swapIn` still upgrades.
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
- **Phase 2 is unproven.** The prediction above is an extrapolation from Node.
  Chrome's paint and the race's silence requirements are not free.

What the next leg must do, in order: (1) the browser rung and a real
`playability.mjs --noworker` run — first frame, ms/move, and **0 console
lines**; (2) `tools/strict-score.mjs` against `js/jsmain-yield.mjs`; (3) a
download-size decision, since shipping both builds is the actual cost; (4)
re-run this census after any transpiler change, because the colouring is a
property of the emitted output and will drift.

Abandoning would be wrong: this is the only route to a resident engine on a
plain static host with no COOP/COEP and no service worker, and it works.
