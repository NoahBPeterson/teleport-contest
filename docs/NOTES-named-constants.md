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
