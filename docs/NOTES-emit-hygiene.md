# Emit hygiene — `__FILE__`, `do{}while(0)`, and function-like macros

Branch `emit-hygiene`, off `main` at `dcd42b6`. Three changes to the emitter,
in the order they were made, which is also the order of how much could go
wrong: a correctness/reproducibility fix, a local rewrite with one real
hazard, and a tier that needed a new analysis before it was allowed to exist.

Every one has a switch, and with all three in their "restore" position the
build reproduces `origin/main`'s `js/generated` byte-for-byte.

| flag | default | what the other setting does |
|---|---|---|
| `C2JS_FILEHYGIENE=0` | **on** | restores the raw clang spelling of `__FILE__` |
| `C2JS_FLATTEN_DO=0` | **on** | restores the literal `do { ... } while (0)` transcription |
| `C2JS_MACROFN=1` | **off** | names function-like macro expansions (§3) — correct, gated, tested, and **+3.4% of slope**, so it does not ship on (§4) |

Two of the three ship on. The third is the interesting one: it is finished
work that the measurement declined, and §4 is the measurement.

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

## 3. Function-like macros — tier 1.12 (built, gated, **off**)

> **Read §3.9 and §4 before turning this on.** Everything in §3 is true and
> every safety argument in it holds; the tier is nonetheless `C2JS_MACROFN=1`
> rather than the default, because six interleaved rounds priced it at +3.4%
> of slope and the standing order is parity > speed > readability. §3.9 is the
> narrowing that was supposed to make it free, and the reason it did not.

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

Three admission rules were built and all three measured. The first shipped
nothing; the second and third are §3.9. `C2JS_MACROFN_REPEAT=0` restores the
wide rule, so all three are still reachable from one checkout.

| | wide (first) | repeat-only | repeat-only, flat audit (§3.9) |
|---|---|---|---|
| helpers in `js/generated/nhmacrofn.js` | 339 | 177 | **212** |
| call sites | 6,202 | 2,726 | **2,297** |
| — case (a), every argument only loads memory | 6,162 | 2,700 | 2,290 |
| — case (b), an argument calls a provably pure function | 40 | 26 | 7 |
| sites where the macro repeated an argument | 2,557 | 2,726 (all) | **2,297 (all)** |
| — of those, ones holding a call (now evaluated once) | 48 | 48 | 10 |
| `js/generated` bytes (`origin/main` = 15,965,231) | 15,599,371 | 15,680,131 | 15,639,713 |

Every one of them *shrinks* the tree: named bodies replace more inline
expansion than the module costs. That is the opposite of the readability leg
before it, which paid +19.5% for its names.

The motivating line from `docs/NOTES-readability.md` §5 — the one this tier
was designed around — only works under the third rule, and §3.9 is why:

```js
// origin/main, detect.js:825 — glyph_at expanded twenty times in one condition
if (!(((glyph_at(…)) == NHC.GLYPH_OBJ_OFF || …) || (…) || (…) || (…)))

// C2JS_MACROFN=1
if (!glyph_is_object(glyph_at(cptr.ldI16(u), cptr.ldI16o(u, $you_uy))))
```

And the one §5 actually wrote down, which every rule names:

```js
// before
if (!((glyph_at(x, y)) >= ((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)
   && (glyph_at(x, y)) < (((((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)) + ((NHC.TRAPNUM - 1) | 0)) | 0)))

// after
if (!glyph_is_trap(glyph_at(x, y)))
```

### the RNG-safety argument for every case-(b) callee

The case-(b) hoists rest on exactly **five** functions — the same five under
every admission rule, which is why narrowing did not need a new safety
argument. Each is pure by the C analysis *and* by the independent audit of its
emitted body:

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

Under the shipping-candidate rule (repeat-only, flat audit), of **16,723**
expansions the extent test matched:

| refused | count | why |
|---|---|---|
| arity | 4,786 | a parameter the body never mentions, so the positional mapping from call-site order to parameter order is not one this can trust |
| **single use** | **4,243** | the body spells every parameter exactly once — §3.9, the narrowing |
| non-value expansion | 2,108 | the expansion is a pointer or a buffer, not a plain value |
| impure body | 1,890 | the body writes, calls something not provably pure, or calls through a parameter |
| parameter name clash | 893 | a parameter name occurs in the body more often than the argument does |
| **conditional-only argument** | **430** | every occurrence of a non-total argument sits behind a short circuit |
| body mismatch | 29 | a second site emitted a different body for the same name |
| split arguments | 23 | two occurrences of one parameter did not emit the same text |
| argument callee not provably pure | 22 | case (b), refused |
| side-effecting argument | 2 | the argument assigns or steps |
| back-substitution audit | **0** | see §3.9 — under the old yardstick this was 1,552, and every one of them was the yardstick |
| alias body | 0 | (the guard that catches the `glyph_is_object` failure; nothing hits it now) |

The default is refuse: anything the walker does not recognize, and any shape it
cannot read, leaves the expansion inline.

`C2JS_MFN_WHY=1` prints one line per (macro, verdict), which is how "why is
`glyph_is_object` not in there?" became a question with an answer instead of a
guess.

### the yieldable build agrees the bodies are pure

`js/generated-y/nhmacrofn.js` contains **zero generators**. yieldify colours
every function that can reach a keystroke read, propagating up the call graph
over the emitted JS; it coloured nothing here. That is an independent
confirmation, from a pass that knows nothing about this tier, that no helper
body can reach anything that blocks — which is the §3 property ("nothing for
the yieldable build to colour") restated as a measurement rather than a rule.

### the one place §3's rule was relaxed

§3 said a helper body may hold "no calls but `cptr.*`". Here a body may also
call a **provably pure** function — the same evidence the argument hoist runs
on. That is what named `clear_path`, `canseemon`, `sensemon`, `has_ceiling` and
the `mondata` predicates; under the shipping-candidate rule `nhmacrofn.js`
calls **15** such functions (and reads 6 module-scope storages besides).

Doing it required splitting `cptr` into loads and effects, which the
object-like tier never had to do because no object-like macro body writes. The
existing `helperFreeVars` would have accepted a body containing
`cptr.stI32o(...)`; it no longer would.

`cmap_to_glyph` is the notable macro this still refuses, under every rule. It
repeats its argument up to **seven** times and would have been the largest
single win, but its body flattens through `cmap_walls_to_glyph`, whose
`In_mines/In_hell/Is_knox/In_sokoban` arms emit `sokoban_dnum()` and friends —
`nhprop.js` helpers, not C functions, so not something `collectPureFunctions`
has a verdict for (28 sites refused on the body, 10 more on arity). Admitting
`nhprop` helpers as callees would work (they are pure loads by construction)
but makes capture order-dependent across incremental builds, which is a
reproducibility risk not worth taking — and, after §4, not one with a payoff.

---

## 3.9. The narrowing, and the bug it uncovered

The first A/B (three complete pairs, §4) put the wide rule at +1.9%..+3.8% of
slope, and named its own fix: of 6,202 sites, 2,557 were macros that **repeat**
a parameter. Those are the sites a helper is *for* — the call replaces N
evaluations with one. Where a body spells each parameter once, the helper
evaluates the argument exactly as often as C did and the only difference is a
call, paid per move, to buy a name for an expansion that read fine inline.

### the rule

One clause, checked **last**, so every refusal count above it still describes
the whole population: some parameter must occur in the body more than once.
Nothing else moved — purity analysis, the conditionality guard, the
back-substitution audit, the name-clash and arity checks, the per-site local
re-check, `assertNamespaceExports()`. `repeats` is a count the audit has
already pinned: it is exactly how many times the emitted body spells the
parameter, so a site that reaches the clause with a repeat is one where the
call *replaces* work.

**6,202 → 2,726 sites, 339 → 177 helpers, 4,568 expansions refused as
single-use.** `C2JS_MACROFN_REPEAT=0` restores the wide rule.

### then: why was `glyph_is_object` never in the module?

It is the macro this tier was designed around, and it was refused at all 17 of
its sites — together with `glyph_is_normal_object`, `glyph_is_statue`,
`glyph_is_body` and `glyph_is_generic_object`. Not for a safety reason. For an
artifact of what the audit compared against.

Helper bodies are captured **flat** — nested substitution suppressed — so that
a helper is a leaf and a site costs one call rather than three (§1.12's own
rule, `docs/NOTES-readability.md` §3). The yardstick that flat body was checked
against was **not** flat: it was this site's tier-active emission, in which the
four nested macros `glyph_is_object` expands to had already been named. Back
substituting a flat body into a nested-and-named emission cannot reproduce it
character for character, so the *outer* macro — the only one whose call
collapses the twenty `glyph_at` evaluations into one — lost to its own leaves,
at every site, and the site emitted a soup of five or six leaf calls instead.

**1,552 of the tier's refusals were this and nothing else.**

The fix is to compare like with like: emit the site's yardstick, its arguments
and its body all with the tier suppressed underneath. That emission is exactly
what a `C2JS_MACROFN=0` build produces at that node — a yardstick this tier
cannot influence, which is a better proof than the one it replaced, because the
old one was checking the tier's output against the tier's output.

| | before | after |
|---|---|---|
| back-substitution refusals | 1,552 | **0** |
| helpers | 177 | **212** |
| call sites | 2,726 | **2,297** |
| `glyph_is_object` sites named | 0 | **17** |
| bodies that call another helper | 0 | **0** (still leaves) |

Fewer sites, more names, and each site is now one call where it was several,
with its argument evaluated once rather than once per leaf. Capture also stopped
depending on which nested macro some earlier module happened to name first,
which is one less order dependence in a build that has already been bitten by
one (§4).

### and it was still not free

§4 measured all of it. The narrowing removed **63%** of the call sites and
**none** of the cost; letting the outer macro win made the slope worse again.
That is the useful finding, and it is a locating one: the cost was never "6,202
calls". It lives in exactly the sites a macro repeats an argument at, because
those are the hot ones — `glyph_is_*`, `IS_POOL`, `ACCESSIBLE` inside the
vision and display loops — and the inline expansion there is what the JIT was
specializing. Naming *more* of one expansion moves it the wrong way for the
same reason.

---

## 4. Gates

Re-run in full on the **shipping tree** (`5044950`: §1 and §2 on,
`C2JS_MACROFN` off), after
`C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs --all --force`.

| gate | result |
|---|---|
| batch build | 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; **0 parse failures** |
| `C2JS_FOLD_VERIFY=1` | **301,692 folds, 0 mismatched, 0 unevaluable** |
| full rebuild reproduces the committed trees | **byte-identical** (`js/generated`, `js/generated-y`, both reset barrels) — `git status` clean after `--force` |
| all three flags off reproduces `origin/main` | **byte-identical** for every file that existed there; the one addition is `nhmacrofn.js`, which comes out with no helpers (same precedent as `nhfield.js`/`nhprop.js` in the readability leg) |
| the shipping tree **is** A/B tree (ii) | `diff -rq` against the measured `C2JS_MACROFN=0` build: **identical**, so §4's numbers describe the committed bytes |
| no-absolute-path assertion | **360 modules, 0 hits** |
| `assertNamespaceExports()` | every `NHC.`/`NHM.`/`FLD.` name a module reads is exported |
| `reset-census` | 179 modules, 45,847 declarations, plan 1,416, **every declaration classified** |
| corpus (`sessions/` + `sessions-extra/`), twice | **69/69** and **69/69** — plus 6 more 69/69 runs of this same tree inside the A/B |
| `reset-diff --via runsegment` | **12/12** pairs byte-identical to a fresh realm (17 forked reference graphs) |
| `purity-audit.mjs` | 0 functions `nhmacrofn.js` calls (tier off), **0 disagree**; under `C2JS_MACROFN=1` it audits the helper module's callees and also reports 0 |
| `test-rnd` / `test-hacklib` / `test-setjmp` / `test-union` | PASS (2,983/2,983 RNG calls; 870 cases, 0 failures) |
| `node --test test/*.test.mjs` | **6/6** |
| `tools/strict-score.mjs` | 507 files reachable from 2 roots, **0 violations** |
| `judge-sim/run.mjs` seed8000, seed0013 | **PASS**, 0 segment mismatches, 0 out-of-scope requests |
| `judge-sim/playability.mjs --their-page --seed=1` | 130 moves, 350 requests, 0 out-of-scope, 0 404s, **0 console entries**, first frame 487 ms |
| sandboxed `playability_runner.mjs` (`node --permission`) | 44 sessions, **0 failures**, 9,096 moves, **3.147 ms/move** (documented baseline 3.03–3.15) |

The escape-analysis unit cases (18/18) were run against §2's scanner when it
landed; §2's code is untouched since, and every build still reports 421 seen /
421 flattened / 0 disagreements.

### a bug this leg's own reproducibility check caught

After the tier landed, a rebuild of the committed tree changed one byte-set:
`nhmacro.js` gained `M3_COVETOUS`. The cause is an ordering one and the effect
was live, not cosmetic. The sidecar modules export the *subset* of names the
tree references, computed by scanning `js/generated` after emission — and
`nhmacrofn.js` was written **after** that scan, so on a clean build its
`NHM.M3_COVETOUS` was invisible and `nhmacro.js` did not export it. A namespace
import of a missing name is `undefined`, not a load error, so the failure would
have surfaced as NaN arithmetic inside the one helper that reads it, in a
session that happens to call it. The corpus does not.

Fixed twice over: the helper modules are now written before their providers are
scanned, and `assertNamespaceExports()` fails the build if any `NHC.`/`NHM.`/
`FLD.` name a module reads is not exported by the module it imports from. A
rebuild now reproduces itself byte-for-byte.

The general lesson is the one this leg keeps re-learning: **a scan-based export
set makes writer order load-bearing**, and every module added to `js/generated`
after this point has to be written before the scans or be caught by the
assertion.

### the first A/B — the wide rule, three pairs

Interleaved ABBA on the scoring path over all 69 sessions, both `js/generated`
and `js/generated-y` swapped every time. **Three complete pairs** (the run was
cut short at 7 of 10 measurements; the fourth `new` run is unpaired and is
excluded from the deltas below).

| | base (`origin/main`) | new (wide tier) | median Δ | min Δ |
|---|---|---|---|---|
| slope (ms/turn) | 0.53 / 0.53 / 0.54 | 0.55 / 0.54 / 0.55 | **+3.8%** | **+1.9%** |
| startup (ms) | 763 / 765 / 771 | 757 / 759 / 763 | **−0.8%** | **−0.8%** |

The direction was consistent in every pair — base never produced a slope above
0.54, new never one below 0.54. **Slope worse, startup better**, both explained
by the same change: 6,202 inline expansions became calls, and there are fewer
source bytes to parse. That is what §3.9 was written to fix.

### the second A/B — four trees, six rounds, and the decision

Same methodology, one more tree and twice the rounds. Both `js/generated` and
`js/generated-y` swapped every time; each round measures all four trees and the
round's direction alternates (`A B C D` / `D C B A`) so a monotone drift
cancels; median **and** min, because the box is shared and drifts.
**24 runs, 69/69 passing in every one.**

| tree | | slope median (min) | vs (ii) median (min) | startup median | corpus total median |
|---|---|---|---|---|---|
| (i) | `origin/main` | 0.5248 (0.5234) | −0.6% (+0.8%) | 795.0 ms | 87,480 ms |
| (ii) | **tasks 1+2**, `C2JS_MACROFN=0` | 0.5280 (0.5192) | — | 811.3 ms | 88,469 ms |
| (iii) | + narrowed tier, 2,726 sites | 0.5390 (0.5349) | **+2.1% (+3.0%)** | 797.4 ms | 88,995 ms |
| (iv) | + narrowed tier, flat audit, 2,297 sites | 0.5457 (0.5377) | **+3.4% (+3.6%)** | **752.8 ms** | **85,659 ms** |

Paired per round against (ii), which is the statistic that survives a drifting
machine:

```
(i)    -0.8  +0.2  -0.1  +1.1  -0.0  -1.0   median -0.1%
(iii)  +1.6  +2.4  +2.4  +3.6  +1.2  +13.6  median +2.4%
(iv)   +3.7  +4.0  +2.0  +3.6  +2.7  +3.9   median +3.6%
```

(iii)'s sixth round is contaminated — 0.6020 is the only slope above 0.56 in
all 24 runs — which is exactly why both statistics are reported and why the
median is the one quoted. It does not change the verdict: (iii) is over the
threshold on the median, the min and five of six clean rounds.

**The decision rule, applied.** Within ±0.5% of (ii) → ship the tier on;
0.5–1.5% → ship it and say so; **>1.5% → ship tasks 1+2 only, keep the tier
behind the flag, document why**. (iii) is +2.1% and (iv) is +3.4%, so the tier
ships **off**, and `5044950` makes `C2JS_MACROFN=1` opt-in.

**Tasks 1 and 2 are free**: (ii) against (i) is −0.6% median and +0.8% min —
i.e. nothing, in both directions, with the sign disagreeing between the two
statistics.

**The narrowing did not fail to work, it worked and told us something.** It
removed 63% of the call sites and none of the cost; (iv) named fewer sites
still and cost more. So the cost is not proportional to calls — it is
concentrated in the repeat sites, which are the hot ones (§3.9).

### the case for turning it on anyway, which is why it is a flag

The same 24 runs say the tier is a **net win in wall time** on this corpus:

| | (ii) tasks 1+2 | (iv) tier on | Δ |
|---|---|---|---|
| startup (median of 6) | 811.3 ms | 752.8 ms | **−7.2%** |
| corpus total, 69 sessions / 61,892 moves (median) | 88,469 ms | 85,659 ms | **−3.2%** |
| corpus total (min) | 85,262 ms | **85,013 ms** | lowest of the four trees |

The arithmetic is exact: 69 sessions × 58 ms of parse saved = −4.0 s, against
61,892 moves × 0.018 ms spent = +1.1 s. The scored path pays startup **once per
session** and this corpus averages ~900 moves a session, so the intercept
dominates the fit's own inputs.

Slope is nonetheless the guard this project set for readability work
(`docs/NOTES-readability.md` §4), for the good reason that a held-out session
may be far longer than 900 moves — break-even is ~3,300 moves, and above that
the tier loses. So the rule is applied as written and the flag defaults off.
Both numbers are here so that turning it on is a decision someone takes on
purpose, with the trade in front of them, rather than an accident.

---

## 5. Commits

* `017d463` — `__FILE__` is the path the compiler was given, not this machine's.
* `e131ad2` — a `do{}while(0)` that nothing jumps out of is just a block.
* `0fc80d0` — function-like macros, and the purity analysis that makes them safe.
* `98cf361` — a macro argument that only loads memory can still fault (the
  conditionality guard, widened from calls to anything non-total: 430 sites).
* `a4a7e78` — a helper body may not call through a parameter (2 helpers).
* `9dfac3b` — write the helper modules before the scans that export to them,
  and assert every namespace name a module reads is exported.
* `1abc455` — name a macro only where it saves an evaluation (§3.9's narrowing:
  6,202 → 2,726 sites, 339 → 177 helpers).
* `2d19ead` — audit a macro body against the emission the tier does not touch
  (§3.9's flat yardstick: `glyph_is_object` and its family, 1,552 → 0 audit
  refusals, 2,726 → 2,297 sites over 212 helpers).
* `5044950` — the tier ships off; the committed trees are the `C2JS_MACROFN=0`
  build, verified byte-identical to A/B tree (ii).

## 6. Merge readiness

**Ready.** What ships is §1 and §2: `__FILE__` relativization and
`do{}while(0)` flattening, both on by default, both free.

* §1 is a correctness fix with a proof read out of the C binary's own string
  table, and it is what makes the build reproducible in a clone at any path.
* §2 is 421/421 with no refusals, no disagreements and no measurable cost.
* §3 is finished, gated, audited and **off**. §4 priced it at +2.1%/+3.4% of
  slope under the two narrowings and the rule said no. It is one flag —
  `C2JS_MACROFN=1` — and §4's last table is the argument for taking that trade
  on a startup-dominated corpus. Nothing in the shipping tree depends on it:
  with the tier off, `nhmacrofn.js` is a header and one import.

The committed `js/generated` differs from `origin/main` only by §1 and §2, and
`C2JS_FILEHYGIENE=0 C2JS_FLATTEN_DO=0` reproduces `origin/main` byte-for-byte.

On `emit-hygiene`, off `main` at `dcd42b6`. Nothing pushed, nothing merged.
`js/generated` must be committed from a **normal** build, never a
`C2JS_FOLD_VERIFY=1` one.
