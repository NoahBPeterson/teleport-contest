# Named constants — the enum tier (roadmap 1.8)

Before this change, every C enum constant reference inlined as a bare integer.
`levl[x][y].typ == ROOM` came out as `cptr.ld1s(cptr.add(lev, 4)) == 25`, and
`u.uprops[BLINDED]` as `cptr.add(cptr.add(u, 112), 15, 24)`. That is unreadable,
and it is also the worst possible shape for Phase 2: NetHack 5.1 renumbers
enums, so a renumbering would have rewritten literals scattered across all 172
generated files with no way to tell an enum 25 from any other 25.

Enum constants now merge into one generated module and are referenced by name.

| | before (a8345b2) | after (Phase A) | after (Phase B) |
|---|---|---|---|
| corpus | 69/69 | 69/69 | 69/69 |
| per-move | 1.0957 ms | 1.0616 ms | 1.0615 ms |
| corpus wall clock | 186.6 s | 172.9 s | 174.4 s |
| js/generated | 13,897,769 B | 14,474,393 B | 14,528,806 B |
| fold audit | 301,692 / 0 bad | 301,692 / 0 bad | 301,692 / 0 bad |

Size grew 4.5%; speed did not regress (the spread between the three runs is
machine noise — all three post-change runs came in at or under the baseline).

## The module

`js/generated/nhconst.js` — 3153 `export const NAME = value;` lines, sorted by
name, written by `writeConstModule()` in `tools/c2js/build.mjs` from the
per-TU `enumValues` maps that `symbols.mjs` already persists into the slim IR.

**Conflicts: zero.** Every one of the 3153 names maps to the same value in
every translation unit that sees it, which is unsurprising — NetHack declares
its enums in shared headers. The build still checks: a name with two different
values across TUs is dropped from the module and keeps inlining as a literal,
and the count is printed on every build (`nhconst: N constants exported`).
None of the names is a JS reserved word, none is a non-identifier, and all
3153 values are integers, so the reserved-word/identifier filters in
`writeConstModule()` are currently no-ops kept as guards.

Sorted-by-name order is deliberate: it is what makes the 5.1 re-transpile's
enum churn a readable diff of one file instead of noise in 172.

## Why a namespace import, and why `NHC`

Generated modules reference the constants as `NHC.WAND_CLASS`, via
`import * as NHC from './nhconst.js';`.

Named imports (`import { WAND_CLASS }`) would have been faster to write and
marginally faster to run, but they are not safe here: C permits a local or a
parameter to shadow an enum constant name, and NetHack does it. A file-scope
`import { ROOM }` captured by a function-local `int ROOM;` is a silent
miscompile — exactly the class of bug that costs a byte-exact corpus.
A namespace prefix cannot be shadowed by a member access.

`NHC` itself is checked rather than assumed. `assemble()` in `build.mjs`
scans each emitted body for a bare `NHC` token — any occurrence not written as
an `NHC.` qualifier — and throws. (`NHC` does appear in the C sources, as a
`#define NHC nh_color` in `coloratt.c`, but a macro is gone by the time clang
emits an AST.) A `$`-prefixed name would have been collision-proof by
construction, since C identifiers cannot contain `$`, but the emitter already
emits `$` in a few places and `NHC.` reads better in code a human has to
review. The build-time assertion buys the same guarantee.

The import line is emitted only in files that actually reference a constant:
134 of 169.

## Phase A — bare references

A *bare* enum constant reference emits `NHC.NAME`. The interesting part is
that a bare reference never reaches `expr_DeclRefExpr` on its own: `emitExpr`
runs `foldConst` first, and a lone enum ref folds. So the naming happens in
two places:

* `emitExpr`'s fold path, via `namedConst(n, c)` — strips parens, `ConstantExpr`
  and value-preserving casts, and names the result only if the folded value
  still equals the constant's own value (so `(char) BIG_ENUM` stays a literal)
  and the result is not 64-bit (`NHC.X` is a Number, and `constExpr` would have
  emitted `123n`).
* `expr_DeclRefExpr`, for the statement-position path where folding is skipped.

Compound constant expressions (`A | B`, `A + 1`) keep their folded literal in
Phase A, so the folder's parity guarantee — a fold is taken only where C's
value and the emitted JS's runtime value agree — is untouched.

The emitted descriptor keeps its numeric `const` field. That matters: `convert()`
and `emitEnum()` read `.const` to fold further, and dropping it would have turned
`Number(descriptor.const)` into `NaN` in enum initializers.

`verifyFold()` now binds `NHC` to the TU's enum values when it evaluates the
unfolded emission, so `C2JS_FOLD_VERIFY=1` still audits every fold:
**301,692 folds evaluated, 0 mismatched, 0 unevaluable.**

## Phase B — small all-enum expressions (shipped)

A folded expression whose leaves are *only* enum constants and integer
literals now keeps its symbolic form, wrapped in explicit parens:

```js
(NHC.GLYPH_OBJ_OFF + NHC.FIRST_OBJECT)   // was 3999
(NHC.S_goodpos - NHC.S_digbeam)          // was 13
(NHC.TRAPNUM - 1)                        // was 25
```

521 sites in 64 files. It is bounded on purpose, because unfolding is
undoing a hot-path optimization (roadmap 1.7, the display.c glyph macros):

* at most 4 leaves, at most 120 characters of emitted code;
* 32-bit results only (no BigInt mixing);
* `sizeof`, the `SIZE()` idiom and `offsetof` never qualify — those carry
  layout meaning that must stay folded;
* always parenthesized, so the form is legal wherever the literal was
  (including `case (A | B):`, where an unparenthesized `x === 1 | 128` once
  produced a real bug — see the comment in `emitSMSwitch`).

Re-emission works by setting `this.symbolic`, which makes `emitExpr` skip the
fold path for the duration, so nested enum leaves emit as `NHC.NAME` instead
of collapsing. Every symbolic form is then evaluated at emit time against the
value C computes — the same discipline as `C2JS_FOLD_VERIFY`, but
unconditional — and any disagreement falls back to the literal.

Positions the task flagged as risky turned out not to be reachable:

* **array sizes / typed-array lengths** come from the *type* (`arr.count`,
  `sizeofType`), never from `emitExpr`, so they cannot be symbolized;
* **address-chain merging** (`mergeConstAdd`) only ever sees numeric struct
  field offsets built with `String(off)`. Confirmed empirically: the count of
  `cptr.add(cptr.add(` in js/generated is **15732 before and after**, i.e. not
  one merge was lost.

Phase B cost 54 KB (+0.4%) and 1.5 s of corpus wall clock, which is inside the
run-to-run noise, and per-move is identical to Phase A to four digits.

## Verification

Run after `node tools/c2js/build.mjs --all --force && git checkout js/generated/isaac64.js`:

| gate | result |
|---|---|
| batch build | 172 files: 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; 0 parse failures |
| `C2JS_FOLD_VERIFY=1` | 301,692 folds, 0 mismatched, 0 unevaluable |
| `tools/c2js/test-rnd.mjs` | PASS |
| `tools/c2js/test-hacklib.mjs` | 870 cases, 0 failures |
| `node --test test/*.test.mjs` | 4/4 (cmachine, libc-string, printf, posix-ere) |
| corpus (`sessions/` + `sessions-extra/`) | **69/69 byte-exact** |
| bare-`NHC` collision scan | 0 hits outside `NHC.` qualifiers |

Two gates fail identically **before and after** this change, i.e. they are
pre-existing and unrelated:

* `tools/c2js/test-setjmp.mjs` and `tools/c2js/test-union.mjs` — the fixture
  ASTs in `.cache/c2js/ast/` produce zero main-file decls on this checkout, so
  `buildSingle` writes a header-only module and the harness reports
  `m.main is not a function`. Verified failing at a8345b2 with the emitter
  changes stashed. Their generated stubs were restored from git, not committed.
* `node tools/strict-score.mjs` — `FORBIDDEN in js/boot/interactive.mjs:
  import('node:worker_threads')`. Also fails at a8345b2. The only difference
  this change makes is the reachable-file count, 182 → 183 (nhconst.js).

## Commits

* `5b804b5` — Phase A: nhconst.js + named bare references.
* `023ea56` — Phase B: symbolic small all-enum constant expressions.

Nothing was pushed. `js/generated/` is generated-but-tracked, so both commits
carry the regenerated output; it must always come from a **normal** build, not
a `C2JS_FOLD_VERIFY=1` build — `verifyFold()` re-emits through the real
emitter methods and so sets `usesConsts` on one extra file, which adds an
unused import. That is pre-existing debug-mode impurity, not new.

---

# Named constants — the macro tier (roadmap 1.9)

The enum tier stopped at values a C `enum` declares. Values born from a
**macro** expansion were still bare integers, and the canonical offender was
`3929`:

```js
// before (b002b16)
cptr.stI32(lev, 3929);                       // display.c:436
cptr.ldI32(lev) >= 3929 && cptr.ldI32(lev) < 3993
for (y = 0; y < 21; y++, ...)                // display.c:1084
```

```js
// after
cptr.stI32(lev, NHC.GLYPH_CMAP_STONE_OFF);
cptr.ldI32(lev) >= NHC.GLYPH_CMAP_STONE_OFF
  && cptr.ldI32(lev) < (((NHC.S_darkroom - NHC.S_ndoor) | 0) + NHC.GLYPH_CMAP_A_OFF)
for (y = 0; y < NHM.ROWNO; y++, ...)
```

Two different provenance problems hide behind "the value came from a macro",
and they got two different mechanisms.

## The one rule both mechanisms obey

A name is only ever recovered from something the C source **is** — a
declaration, or a spelling location. Never from a value.

That is not fastidiousness, it is forced. `3929` is *both* `GLYPH_CMAP_OFF`
and `GLYPH_CMAP_STONE_OFF`; `1` is `OBJ_FLOOR` and `CLR_RED` and `COULD_SEE`
and a hundred others. A value→name table would have to guess, and **a wrong
name on a right value is worse than a bare number** — it is a lie that
survives review and misdirects the 5.1 merge. Value equality is used only as
the *audit* (does the name we recovered still equal what C computes?), never
as the search key.

Every named emission is checked that way, unconditionally, not just under
`C2JS_FOLD_VERIFY`. In the shipping build: **0 refused**, i.e. no site
disagreed.

## Tier 1 — the arm the macro selected (`constArm`)

`cmap_to_glyph()` and its family (include/display.h) are conditional chains
that the macro's own argument decides at compile time:

```c
#define cmap_to_glyph(cmap_idx) \
    ( ((cmap_idx) == S_stone)   ? GLYPH_CMAP_STONE_OFF    \
    : ((cmap_idx) <= S_trwall)  ? cmap_walls_to_glyph(cmap_idx) \
    : ((cmap_idx) <  S_altar)   ? cmap_a_to_glyph(cmap_idx) ... )
```

So the value a call folds to was *written*, in one arm, as a symbolic form.
Two places gave up before reaching it:

* `namedConst()` peeled parens and casts, then required a `DeclRefExpr` — and
  found a `ConditionalOperator`;
* `constLeaves()` counted the leaves of **every** arm, so `cmap_to_glyph` came
  to ~20 leaves and blew the Phase-B budget, when its live arm has 1–3.

Both now descend through `constArm(n)`: a `ConditionalOperator` whose condition
folds *is* its selected arm. `expr_ConditionalOperator` already dropped the
dead arm at emit time, so this is not a new judgement about which arm runs —
it is the same one, made available to the naming paths.

* `cmap_to_glyph(S_stone)` → the arm is a bare enum ref → `NHC.GLYPH_CMAP_STONE_OFF`
* `cmap_to_glyph(S_room)` → the arm is 3 leaves → `((NHC.S_room - NHC.S_ndoor) | 0) + NHC.GLYPH_CMAP_A_OFF`

**88 sites** (6 named, 82 symbolic). Small, and that is the point: it is the
single most-looked-at number in the codebase.

Two supporting changes came with it:

* symbolic re-emission of a compile-time conditional now emits **only** the
  live arm rather than emitting both and discarding one. The old symmetry was
  harmless when nothing downstream of it was reachable; with the arm peel, a
  dead arm containing a string literal would have registered a `__slN` in a
  file whose output never mentions it.
* a fully-enclosing paren pair is stripped from a symbolic form before it is
  wrapped, because macro bodies bring their own — `((NHC.A - NHC.B))` →
  `(NHC.A - NHC.B)`. This is what touches 51 files; it is cosmetic.

### The budget, raised 4 → 6

With the arm peel in, the sites still over Phase B's 4-leaf cap were dominated
by the glyph **range** tests, which need 5: `glyph_is_cmap_b()`'s bound is
`GLYPH_CMAP_B_OFF + (S_arrow_trap + MAXTCHARS - S_grave)`, and the symbol-set
offsets are `SYM_BOULDER + MAXPCHARS + MAXOCLASSES + MAXMCLASSES + 6`. Those
are the same 5.1-churn surface as the offsets, so leaving the bounds numeric
would have split the family across the diff. 6 adds 60 sites in 9 files for
6470 B and no measurable time; 83 sites remain over budget and stay folded.

The cap is now a knob (`C2JS_SYM_LEAVES`, `C2JS_SYM_CHARS`), and
`C2JS_SYM_STATS=1` prints what was named and what the budget turned away —
unfolding is still undoing a hot-path optimization, so it should be raised on
evidence, which is now cheap to gather.

## Tier 2 — the spelling location (`namedMacro`, nhmacro.js)

`#define COLNO 80` leaves *no* declaration in the AST. But the IntegerLiteral
it expands to records where its token was spelled — and that is the macro's
own body. Naming by location is the exact analogue of the enum tier's naming
by declaration.

`scanMacroDefs()` reads `nethack-c/recorder/include/*.h` for object-like
`#define`s **whose entire body is one integer token**. Only those can have
spelled an IntegerLiteral, and C makes a preprocessor directive own its line,
so a `(header, line)` match identifies the macro with no ambiguity — two
macros can never share a key.

`namedMacro()` requires all of:

1. the spelling file is one of NetHack's own headers, as the compile database
   spells them (`../include/x.h`) — not an SDK header, not clang's
   `<scratch space>`;
2. the location carries **both** a file and a line. Clang omits either when it
   is unchanged since the previous location it printed, and a partly-inherited
   location is not a location. This is a real cost, not a formality: it is why
   only 12,970 of a possible ~25,000 sites are named. Resolving inherited
   locations needs clang's print-order state machine, which `ir.mjs` runs at
   IR-build time over the *full* AST and then discards — recovering it means
   stamping resolved spelling locations into the slim IR and rebuilding it.
   Worth doing; deliberately not done here, since it is a separable change to
   a different file with a different verification story;
3. the macro's value equals the value C folds the node to. This is what makes
   a `1` spelled inside some *other* macro's body impossible to mis-name.

**12,970 sites, 798 distinct macros, 0 refused by the audit.**

`AD_PHYS` 546, `ECMD_OK` 445, `ECMD_TIME` 405, `IN_SIGHT` 313, `NO_COLOR` 254,
`AT_WEAP` 234, `ROWNO` 121, `COLNO`, `BUFSZ`, the `CLR_*`, `M1_*`, `M2_*`,
`AM_*`, `MZ_*` families — i.e. exactly the monst/objects initializer tables
and the map-dimension loops.

### Independently audited against the preprocessor

The header scan is a regex, so it was checked against the real thing:
`clang -E -dM` over **every** `src/*.c` with the AST-dump flags
(`-I../include -DNOTPARMDECL -DNO_TIMED_DELAY`), compared to `nhmacro.js`.

**798 / 798 values agree. 0 disagree.** (This touches no AST cache.)

That comparison also found the scan's one blind spot, and fixed the module
because of it: reading definition *text* rather than preprocessor state, the
scan can pick up a name whose live definition is elsewhere (`NHW_BASE` is a
literal in one `#define` and `(NHW_LAST_TYPE + 1)` in the branch that wins),
or one that is not NetHack's at all (`__STDC__`, `__GNUC__`). Such a name can
never be *emitted* — a site is only named when the token was spelled at the
matched line, and the value is checked — but exporting it would have put a
wrong-looking number in a module people read.

So `nhmacro.js` is written **after** emission and exports exactly the names the
generated files reference, read back out of those files. 1286 scanned → 798
exported. Reading the output rather than tallying per-file is deliberate: the
batch build is incremental, and a file whose emission was skipped would not
have reported its names — a missing export is a runtime `undefined` in a
byte-exact program.

### Why a second module and a second prefix

`NHM` / `nhmacro.js` rather than folding into `NHC` / `nhconst.js`: these are a
different provenance tier with a different 5.1 story. Enum renumbering and
`#define` retuning are separate events, and keeping them in separate files
keeps each diff readable — which is the entire purpose of the exercise.
Namespace import for the same reason as `NHC` (a C local can shadow a macro
name; a member access cannot be shadowed), and `assemble()` asserts no emitted
body contains a bare `NHM` token, exactly as it does for `NHC`.

### What stays numeric, and why

* **64-bit macros.** `#define M1_FLY 0x00000010L` folds at 64 bits, where
  `constExpr` emits `16n`; an `NHM.X` is a Number and would poison BigInt
  arithmetic. Same guard the enum tier uses. Naming these needs the module to
  export BigInt for exactly those names — possible, not attempted.
* **Locations with an inherited file or line** (see above) — ~half the
  candidates.
* **Macro leaves inside a symbolic form.** Symbolic re-emission skips the fold
  path, so an IntegerLiteral leaf inside `(NHC.A - NHC.B)` never reaches
  `namedMacro`. Bounded and consistent; not worth the coupling yet.
* **Function-like macros, and macros whose body is an expression**
  (`#define SIZE(x) ...`, `#define NHW_BASE (NHW_LAST_TYPE + 1)`). There is no
  single token to attribute, and reconstructing one would be pattern-matching
  on values — the thing this design refuses to do.
* **Array sizes and typed-array lengths**, as in Phase B: they come from the
  *type* (`arr.count`, `sizeofType`), never from `emitExpr`.

## Verification

Run after `node tools/c2js/build.mjs --all --force && git checkout js/generated/isaac64.js`:

| gate | result |
|---|---|
| batch build | 172 files: 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; 0 parse failures |
| `C2JS_FOLD_VERIFY=1` | 301,692 folds, 0 mismatched, 0 unevaluable (unchanged from 1.8) |
| named-emission audit | 40,361 named + 1,318 symbolic + 12,970 macro-spelled, **0 refused** |
| `nhmacro.js` vs `clang -E -dM` | 798/798 agree, 0 disagree |
| `tools/c2js/test-rnd.mjs` | PASS |
| `tools/c2js/test-hacklib.mjs` | 870 cases, 0 failures |
| `tools/c2js/test-setjmp.mjs`, `test-union.mjs` | PASS (both were failing at 1.8; b002b16's AST self-healing fixed them) |
| `node --test test/*.test.mjs` | 4/4 (cmachine, libc-string, printf, posix-ere) |
| corpus (`sessions/` + `sessions-extra/`) | **69/69 byte-exact** |
| bare-`NHC` / bare-`NHM` collision scan | 0 hits outside qualifiers |

### Deltas vs b002b16

| | b002b16 | 47bdd97 (arm peel) | d9a6da2 (budget 6) | 2e47a5c (macro tier) |
|---|---|---|---|---|
| corpus | 69/69 | 69/69 | 69/69 | 69/69 |
| per-move | 1.0368 ms | 1.0368 ms | 1.04 ms | 1.03 ms |
| corpus wall clock | 182.6 s | — | — | 157.5 s |
| js/generated | 14,528,806 B | 14,531,821 B | 14,538,291 B | 14,721,427 B |
| fold audit | 301,692 / 0 bad | 301,692 / 0 bad | — | 301,692 / 0 bad |

Total size cost **+192,621 B (+1.3%)**, of which nhmacro.js is 24,884 B. No speed
cost: three corpus runs of the final tree came in at 1.03, 1.08 and 1.27
ms/move — the 1.27 is machine contention, and 1.03 is both the median-of-best
and below the b002b16 baseline. Module namespace loads are immutable bindings,
which V8 folds; `for (x = 1; x < NHM.COLNO; x++)` costs nothing measurable.

`node tools/strict-score.mjs` still fails on
`FORBIDDEN in js/boot/interactive.mjs: import('node:worker_threads')`, as it did
at 1.8 and at a8345b2. The only change is the reachable-file count, 183 → 184
(nhmacro.js).

## Commits

* `47bdd97` — name constants born from macro expansion (the arm peel).
* `d9a6da2` — symbolic budget 4 → 6, for the glyph range bounds.
* `2e47a5c` — object-like `#define`s named by spelling location (nhmacro.js).

Nothing was pushed. As in 1.8, `js/generated/` must be committed from a
**normal** build, never a `C2JS_FOLD_VERIFY=1` one.
