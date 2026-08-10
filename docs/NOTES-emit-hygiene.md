# Emit hygiene — `__FILE__`, `do{}while(0)`, and function-like macros

Branch `emit-hygiene`, off `main` at `dcd42b6`. Three changes to the emitter,
in the order they were made, which is also the order of how much could go
wrong: a correctness/reproducibility fix, a local rewrite with one real
hazard, and a tier that needed a new analysis before it was allowed to exist.

Every one has an off switch, and with all three off the build reproduces
`origin/main`'s `js/generated` byte-for-byte.

| flag | default | off restores |
|---|---|---|
| `C2JS_FILEHYGIENE=0` | on | the raw clang spelling of `__FILE__` |
| `C2JS_FLATTEN_DO=0` | on | the literal `do { ... } while (0)` transcription |
| `C2JS_MACROFN=0` | on | function-like macro expansions, inline |

---

## 1. `__FILE__` — what the C binary actually contained

### the leak

94 string literals in `js/generated` spelled out an absolute path on the
machine that ran the transpiler:

```js
const __sl1 = cptr.lit("/Users/noahpeterson/Documents/Projects/teleport-contest-research/original-contest-to-fork/nethack-c/recorder/src/dbridge.c");
```

100 files in `js/generated`, 100 more in `js/generated-y`. They are there
because NetHack expands `__FILE__` at every allocation and every panic —

```c
#define nhalloc(p)  nhalloc_((p), __FILE__, (int) __LINE__)      global.h:336-339
/* panic, impossible, debugcore */                               global.h:471
```

— and because `ast-dump.mjs` hands clang an **absolute** path to each `.c`
file (it dumps one translation unit at a time into a shared cache), so clang
expanded `__FILE__` to that absolute path.

Three defects, of which only the first is cosmetic:

* the shipped tree publishes the maintainer's directory layout;
* the build is byte-reproducible **only on this machine** — a fresh clone at a
  different path rebuilds different bytes, which is exactly the "reproducible
  transpilation" property Phase 2 is scored on;
* **parity.** These strings are the `file` argument of `nhalloc`, `nhrealloc`,
  `nhfree`, `nhassert_failed`, `panic`, `impossible` and `debugcore`. A session
  that panics or trips an assert would print a path the C recorder never held.
  The corpus does not exercise it. A held-out session might.

### the ground truth, read rather than assumed

The obvious guess is "basename", and the obvious guess is wrong for two files.
The evidence is in NetHack's own build and in the binary it produced.

`src/Makefile` compiles with make's cwd in `src/` and passes `$<`:

```make
$(TARGETPFX)%.o : %.c                                     src/Makefile:459
	$(TARGET_CC) $(TARGET_CFLAGS) -c -o $@ $<             src/Makefile:460
```

`$<` is the prerequisite **as written**. For a file in `src/` that is a bare
`dbridge.c`. The two tty files are named by their own rules, by relative path:

```make
$(TARGETPFX)topl.o:   ../win/tty/topl.c   ...                       :1183
$(TARGETPFX)wintty.o: ../win/tty/wintty.c ...                       :1186
```

The linked recorder agrees exactly. `strings nethack-c/recorder/src/nethack`
gives **98 bare basenames**, **precisely two** slashed paths —
`../win/tty/topl.c` and `../win/tty/wintty.c` — and **zero** strings containing
an absolute path (`grep -c '/Users/'` → 0, `'/home/'` → 0). And the literal is
in the runtime string section, not merely in debug info:

```
$ otool -s __TEXT __cstring nethack-c/recorder/src/dbridge.o
...
0000000000004ac8  6400212a 64697262 632e6567   ...d!*dbridge.c
```

### the rule

clang was invoked from the same directory make was: `compileCwdFor()` already
returns `<recorder>/src` as the AST-dump cwd. So the C build's spelling is
recovered by re-relativizing the absolute path **to the compile cwd** — no
table of special cases, and `../win/tty/wintty.c` falls out on its own.

Verified rather than asserted: all 94 absolute literals map to a spelling that
appears **verbatim in the recorder binary's own string table** (set membership,
94/94), and all 94 appear in the rebuilt tree.

The rewrite sits in `cStringToJs`, the one point every C string literal passes
through, so it covers interned `__slN` literals, `cptr.bytes(...)` initializers
and struct-field `strcpy` sources alike. It is guarded three ways so a genuine
game string can never be caught: the literal must be an absolute path, must end
`.c`/`.h`, and must name a file that exists.

One side effect worth naming: `zap.c` already had a literal `"zap.c"` from
another source, so the normalized `__FILE__` literal now **dedups** with it and
the module's string table loses an entry. That is the C compiler's behaviour
too — one `zap.c` in the binary, not two.

### the second route

18 more occurrences reached `/** C ref: */` comments, where clang spells an
anonymous record as `struct (unnamed struct at <abs path>:LINE:COL)`. No
session can print a comment, but they carry the same layout and make the same
clone rebuild different bytes, so they get the same treatment — applied **only
to the comment copy** of a type spelling, because `recordNameOf` and the
`anonByLoc` recovery match against raw `desugar()` output and rewriting what
those see is a correctness question, not a cosmetic one.

### the assertion

`assertNoAbsolutePaths` runs per module in `assemble()` and again over both
finished trees at the end of the build, so it also covers the sidecar modules,
yieldify's rewrite and resetify's appended blocks. **360 modules, clean.**

"Contains no absolute path" would be too strong to be true, and the first
version of this gate failed on a real string: `loslib.c` defines
`LUA_TMPNAMTEMPLATE "/tmp/lua_XXXXXX"`, the recorder binary contains it, and
emitting it is parity. So the test is two exact parts: no occurrence of this
checkout's own root (in either its literal or symlink-resolved spelling), and
no occurrence of a home directory at all — the latter justified by the binary
having zero of them. Both hold in a clone at any path, which is what makes it a
gate a contributor can run rather than a description of one machine.

**Not touched:** `js/boot/harness.mjs` and `harness-y.mjs` carry a hard-coded
`/Users/davidbau/...` in a `VHOME` constant. That is upstream's own dev
comparison harness, hand-written rather than emitted, and out of this leg's
scope; it is called out here so it is not mistaken for a miss.

---

## 2. `do { ... } while (0)` — 421 of them, 421 gone

They are C macro hygiene: `do{}while(0)` is how a multi-statement macro is made
safe to write `if (x) MACRO(); else ...` around. JS has no such problem, and a
plain block runs the body exactly once too.

It is free only while nothing binds to the loop, and the thing that binds is
real: C macros use a bare `break` as an **early exit from the macro body**.
Flattening one of those re-aims it at whatever loop or switch encloses the
macro — sometimes a syntax error, sometimes silent. `continue` is the same
argument, and a `switch` captures `break` but never `continue`.

### the test runs on the emitted text, not the AST

The emitter already has `hasUnboundBreak`/`hasUnboundContinue`, which encode
C's rule precisely (`SwitchStmt` is a barrier for `break` and deliberately
absent from the `continue` barrier list). They describe the C the body was
*written* as. By the time a block reaches `stmt_DoStmt`, the goto lowering may
have spliced an `inline` label's region into it, and those statements are not
children of this `DoStmt`. A token scan of what was actually emitted sees them.

Both are computed at every site and disagreements counted, because a
disagreement is exactly a splice.

The scanner is sound in the direction that matters — every way of being unsure
answers "it escapes", and the site is left alone:

* a labelled `break L` / `continue L` is ignored: it binds to its label;
* only a **braced** loop/switch body is credited with capturing, so
  `while (c) break;` reads as an escape;
* `switch` captures `break`, never `continue`;
* the pending-header state is cleared at the first `;` outside parens, so a
  `break` *after* a one-line loop body is not mistaken for one inside it.

Eighteen synthetic cases pin the behaviour, including the two that matter — a
switch not capturing `continue`, and a `break` after an inner do-while.

Three things the change deliberately does **not** do, each because the
exploration found a hazard:

* it does not touch the AST, so `hasUnboundBreak`'s verdicts at the eight goto
  and state-machine decision points are unchanged;
* it does not touch `analyzeGotos`, where `DoStmt` is a boundary in the
  inline-splice outward scan (`emit.mjs:2774`) — the comments there record real
  game bugs from getting that wrong;
* it still calls `condExpr(cond)` even when the condition is discarded, because
  `condExpr` interns string literals and the file's string table must not
  depend on a decision taken after it.

Braces stay. They are the scope for any `let`/`const` the body declares, and
the visible trace of the macro.

### result

| | |
|---|---|
| `do { … } while (0)` seen | **421** |
| flattened | **421** |
| refused for a macro-local `break`/`continue` | **0** |
| refused for one the goto lowering spliced in | **0** |
| sites where the emitted text and the AST disagreed | **0** |

No macro in this corpus exits itself with a `break`, so nothing is left behind
— the emitter no longer produces `} while (0);` at all. The analysis is kept
anyway: it is what makes the next corpus safe.

---

## 3. Function-like macros — tier 1.12

`docs/NOTES-readability.md` §5 designed this and deferred it. The reason it
deferred it is the whole problem:

> C expands `g` twice, so `glyph_is_trap(glyph_at(x, y))` calls `glyph_at`
> twice — which is why the emitted code calls it twice today. A helper taking
> one parameter calls it once. In a program scored on an exact PRNG trace,
> changing how many times a function runs is a parity change, not an
> optimization.

§5 named two ways out: prove the argument side-effect-free, or restrict to
macros that use each parameter exactly once. This takes the first.

### what is an argument

The extent test is unchanged from the object-like tier: a node whose
`range.begin`/`range.end` spelling locations land on one macro body's first and
last token **is** that macro's complete expansion.

Inside it, **a node spelled in a NetHack header is body; a node spelled
anywhere else was written at the call site and is an argument.**

An offset range around the macro's own body is not enough, and getting it wrong
is silent. `glyph_is_object`'s body is four other macros —

```c
#define glyph_is_object(glyph) \
    (glyph_is_normal_object(glyph) || glyph_is_generic_object(glyph)   \
     || glyph_is_statue(glyph) || glyph_is_body(glyph))
```

— and those live at their own offsets **in the same header**, outside the
range. Reading them as arguments produced a helper whose entire body was
`(glyph)`: byte-faithful, audit-passing, and meaningless. A body that is
nothing but its own parameters is now refused outright, which is §3's alias
rule and also the shape a misclassified argument makes.

Two occurrences of one parameter expand from the *same* call-site tokens, so
they group together, and the size of that group is **the number of times C
evaluates that argument** — the quantity this tier exists to change.

### the purity analysis

A least fixed point over the C call graph, on the slim IR rather than the
emitted JS, because the emitter needs the answer before any module is written.
Seeded pessimistically:

> `impure(f)` if `f` writes anywhere it did not itself declare, or calls
> anything not proven pure — including every function whose definition this
> build never saw (libc, the window port) and every call through a function
> pointer.

"Writes anywhere it did not itself declare" is the load-bearing clause. An
assignment to a plain local is unobservable and does not count; an assignment
through a pointer, to a field, to an array element, or to a global does, and a
function that declares a `static` is out because that storage outlives the
call.

**Reading a mutable global is allowed.** Between the N evaluations C would have
performed, nothing runs but the macro body, and the body is itself restricted
to pure loads — so all N reads see the same bytes.

**819 of 6,586 functions qualify.**

#### it is cross-checked, not trusted

`tools/c2js/purity-audit.mjs` re-derives the verdict from the other end: the
emitted JavaScript, in its own vocabulary of effects — the mutating half of
`cptr` (`st*`, `memcpy`, `strcpy`, `alloc`, `free`, `box`, `addr`, `qsort`,
`printf`, `read`/`write`, `vaArg`), the RNG entry points in `rnd.js`, and
anything it cannot resolve. The two analyses are required to agree.

They did not, once. `strncmpi` steps a pointer parameter, which is a local
write in C but which the emitter lowers to `cptr.postinc(get, set)` — an
indirect call whose effects are not visible where it is written. The
emitted-code reader cannot vouch for that, so **the C-side analysis gave way**:
stepping a pointer local now makes a function impure. 870 → 819 pure functions,
and the audit reports **0 disagreements**.

### the safety condition, in full

A site is transformed only when, for every argument:

1. the argument is **evaluation-safe** — it contains no assignment, no `++`/
   `--`, no call through a function pointer, and every function it calls is
   provably pure; **and**
2. if it contains a call, at least one of its occurrences in the body is
   **unconditional** (not behind `&&`, `||` or `?:`). A helper evaluates every
   argument before the body runs; for a load that is unobservable, for a call
   it is not — unless C was always going to make it. This is what stops the
   tier introducing an evaluation, and with it a fault, on a path C never took.

and, for the expansion as a whole:

3. putting the arguments back into the helper body reproduces this site's own
   inline emission **character for character** (§3's audit);
4. each parameter occurs in the body exactly as many times as its group has
   nodes — which pins the parameter names and catches a body that mentions
   `glyph` for its own reasons;
5. the body is the pure loads §3 admits, and every free name it reads resolves
   at the helper module's scope and is **not** a local at this site, re-checked
   at every site rather than only where the body was captured.

Note what condition (2) does **not** require: a temporary. The hoist §5
imagined is just the JS call itself — `glyph_is_trap(glyph_at(x, y))` evaluates
its argument once because that is what a function call does. No statement-level
hoisting machinery was needed, and none was added, which also means the tier
cannot move an evaluation out of a loop condition.

### what it bought

| | |
|---|---|
| helpers in `js/generated/nhmacrofn.js` | **356** |
| call sites | **6,659** |
| — case (a), every argument only loads memory | **6,619** |
| — case (b), an argument calls a provably pure function | **40** |
| sites where the macro repeated an argument | **2,579** |
| — of those repeats, ones holding a call (now evaluated once) | **48** |

The motivating line, `detect.js`:

```js
// before
if (!((glyph_at(x, y)) >= ((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)
   && (glyph_at(x, y)) < (((((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)) + ((NHC.TRAPNUM - 1) | 0)) | 0)))

// after
if (!glyph_is_trap(glyph_at(x, y)))
```

### the RNG-safety argument for every case-(b) callee

All 48 case-(b) hoists rest on exactly **five** functions. Each is pure by the
C analysis *and* by the independent audit of its emitted body:

| callee | macros that hoisted it | emitted callees | effects |
|---|---|---|---|
| `glyph_at` | 28 `glyph_is_*` / `glyph_to_obj` | **none** | **none** |
| `minuhpmax` | `max` | `max` | assigns one local |
| `isqrt` | `min` | none | assigns locals only |
| `depth` | `max` | `schar` | none |
| `distmin` | `max` | `i16` | assigns locals only |

`glyph_at` is the strongest case available and the one §5 flagged. Its whole
body is:

```js
export function glyph_at(x, y) {
    if (x < 0 || y < 0 || x >= NHM.COLNO || y >= NHM.ROWNO)
        return (((((NHC.S_room) - NHC.S_ndoor) | 0) + NHC.GLYPH_CMAP_A_OFF) | 0);
    return cptr.ldI32o3(gg, y, 4480, x, 56, $gbuf_entry_glyphinfo);
}
```

One `cptr` load, which is in the read-only half; two namespace constant reads;
one module-scope field offset. **It makes no function call at all**, so there
is no path from it to any RNG. `rn2_on_display_rng` does live nearby — 20 lines
above, in `swallow_to_glyph` — and `display.js` imports it at module scope, but
a module-level import is not evidence about a function body, and `glyph_at`'s
body neither names it nor reaches anything that could. The C source agrees:
`display.c:2477-2483` is a bounds check and an array read, and its
`cmap_to_glyph(S_room)` arm was constant-folded at emit time because `S_room`
is a literal.

### refusals, and why

Of **18,286** expansions the extent test matched:

| refused | count | why |
|---|---|---|
| arity | 4,839 | a parameter the body never mentions, so the positional mapping from call-site order to parameter order is not one this can trust |
| non-value expansion | 2,360 | the expansion is a pointer or a buffer, not a plain value |
| back-substitution audit | 1,601 | putting the arguments back did not reproduce the inline emission |
| impure body | 1,496 | the body writes, or calls something not provably pure |
| parameter name clash | 905 | a parameter name occurs in the body more often than the argument does |
| body mismatch | 379 | a second site emitted a different body for the same name |
| split arguments | 23 | two occurrences of one parameter did not emit the same text |
| argument callee not provably pure | 22 | case (b), refused |
| side-effecting argument | 2 | the argument assigns or steps |
| conditional-only argument | 0 | every occurrence behind a short circuit |
| alias body | 0 | (the guard that catches the `glyph_is_object` failure; nothing hits it now) |

The default is refuse: anything the walker does not recognize, and any shape it
cannot read, leaves the expansion inline.

### the one place §3's rule was relaxed

§3 said a helper body may hold "no calls but `cptr.*`". Here a body may also
call a **provably pure** function — the same evidence the argument hoist runs
on. That is what named `on_level`, `clear_path`, `canseemon`, `sensemon` and
the `mondata` predicates; `nhmacrofn.js` imports 14 such functions.

Doing it required splitting `cptr` into loads and effects, which the
object-like tier never had to do because no object-like macro body writes. The
existing `helperFreeVars` would have accepted a body containing
`cptr.stI32o(...)`; it no longer would.

`cmap_to_glyph` is the notable macro this still refuses. It repeats its
argument up to **seven** times and would have been the largest single win, but
its emitted body calls `sokoban_dnum()` — an `nhprop.js` helper, not a C
function, so not something `collectPureFunctions` has a verdict for. Admitting
`nhprop` helpers as callees would work (they are pure loads by construction)
but makes capture order-dependent across incremental builds, which is a
reproducibility risk not worth taking in this leg. It is the obvious next step.

---

## 4. Gates

Run at `0fc80d0`, after `C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs --all --force`.

| gate | result |
|---|---|
| batch build | 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; **0 parse failures**; all 178 yield files parse |
| `C2JS_FOLD_VERIFY=1` | **336,808 folds, 0 mismatched, 0 unevaluable** |
| full rebuild reproduces the committed trees | **byte-identical** (`js/generated`, `js/generated-y`, both reset barrels) |
| all three flags off reproduces `origin/main` | **byte-identical** (`git diff origin/main -- js/` empty; `nhmacrofn.js` comes out with no helpers) |
| no-absolute-path assertion | **360 modules, 0 hits** |
| `reset-census` | 179 modules, 45,964 declarations, plan 1,416, **0 unclassified** |
| corpus (`sessions/` + `sessions-extra/`), twice | **69/69** and **69/69** |
| `reset-diff --via runsegment` | **12/12** pairs byte-identical to a fresh realm |
| `purity-audit.mjs` | 14 functions `nhmacrofn.js` calls, **0 disagree** with the AST analysis |
| escape-analysis unit cases | **18/18** |
| `test-rnd` / `test-hacklib` / `test-setjmp` / `test-union` | PASS (2,983/2,983 RNG calls; 870 cases, 0 failures) |
| `node --test test/*.test.mjs` | **6/6** |
| `tools/strict-score.mjs` | 509 files reachable from 2 roots, **0 violations** |
| `judge-sim/run.mjs` seed8000, seed0013 | **PASS**, 0 segment mismatches, 0 out-of-scope requests |
| `judge-sim/playability.mjs --their-page --seed=1` | 130 moves, 351 requests, 0 out-of-scope, 0 404s, **0 console entries**, first frame 536 ms |
| sandboxed `playability_runner.mjs` (`node --permission`) | 44 sessions, **0 failures**, 9,096 moves, **3.18 ms/move** (documented baseline 3.03–3.15) |

### the A/B

PERF_TABLE_PLACEHOLDER

---

## 5. Commits

* `017d463` — `__FILE__` is the path the compiler was given, not this machine's.
* `e131ad2` — a `do{}while(0)` that nothing jumps out of is just a block.
* `0fc80d0` — function-like macros, and the purity analysis that makes them safe.

On `emit-hygiene`, off `main` at `dcd42b6`. Nothing pushed, nothing merged.
`js/generated` must be committed from a **normal** build, never a
`C2JS_FOLD_VERIFY=1` one.
