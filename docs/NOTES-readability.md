# Readability — the vocabulary tier (roadmap 1.11)

The enum tier (1.8) and the macro tier (1.9) gave the generated code back the
*names* of the values it computes. What they could not touch is the shape of
the code around those values: C's int-0/1 normalization on every logical
operator, the byte offset of every struct field, and the body of every
expression-valued macro re-inlined at each of its sites.

This leg is those three. The standard to beat was named up front —
`js/generated/detect.js`'s `map_monst`, `trapped_chest_at`, `trapped_door_at` —
so they are the acceptance demo, pasted below before and after.

Nothing here changes what the program does. Every class is emitter-side,
flag-gated, and verified by the corpus: the *bytes* of the generated code
change, the game's output does not.

---

## The acceptance demo

### before (`524c52d`)

```js
/** C ref: detect.c:122 — @param {CPtr} mtmp @param {CInt} showtail */
function map_monst(mtmp, showtail) {
    let glyph = ((cptr.ld1so(def_monsyms, cptr.ld1so((cptr.ldPtro(mtmp, 8)), 28), 24)) == 32) ? ((((cptr.ldI64o2(u, NHC.HALLUC, 24, 128) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 128) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 112) ? 1 : 0) ? 1 : 0) ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), 8)), 24))) + ((((cptr.ldI32o((mtmp), 84) & 1) | 0) == 0) ? NHC.GLYPH_DETECT_MALE_OFF : NHC.GLYPH_DETECT_FEM_OFF)) | 0) : (cptr.ld1so(mtmp, 65) ? ((((cptr.ldI64o2(u, NHC.HALLUC, 24, 128) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 128) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 112) ? 1 : 0) ? 1 : 0) ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), 8)), 24))) + ((((cptr.ldI32o((mtmp), 84) & 1) | 0) == 0) ? NHC.GLYPH_PET_MALE_OFF : NHC.GLYPH_PET_FEM_OFF)) | 0) : ((((cptr.ldI64o2(u, NHC.HALLUC, 24, 128) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 128) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 112) ? 1 : 0) ? 1 : 0) ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), 8)), 24))) + ((((cptr.ldI32o((mtmp), 84) & 1) | 0) == 0) ? NHC.GLYPH_MON_MALE_OFF : NHC.GLYPH_MON_FEM_OFF)) | 0));
    show_glyph(cptr.ldI16o(mtmp, 28), cptr.ldI16o(mtmp, 30), glyph);
    if (showtail && cptr.eq(cptr.ldPtro(mtmp, 8), cptr.add(mons, NHC.PM_LONG_WORM, 96)) ? 1 : 0)
        detect_wsegs(mtmp, 0);
}

/** C ref: detect.c:139 — @param {CInt} ttyp @param {CInt} x @param {CInt} y @returns {CInt} */
export function trapped_chest_at(ttyp, x, y) {
    let mtmp;
    let otmp;
    if (!((glyph_at(x, y)) >= ((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0) && (glyph_at(x, y)) < (((((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)) + ((NHC.TRAPNUM - 1) | 0)) | 0) ? 1 : 0))
        return 0;
    if (ttyp != NHC.TRAPPED_CHEST || ((cptr.ldI64o2(u, NHC.HALLUC, 24, 128) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 128) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 112) ? 1 : 0) ? 1 : 0) && (rng_log_enabled() ? (rng_log_set_caller(__sl0, 146, __sl1), rn2(20)) : rn2(20)) ? 1 : 0) ? 1 : 0)
        return 0;
    if (sobj_at(NHC.CHEST, x, y) || sobj_at(NHC.LARGE_BOX, x, y) ? 1 : 0)
        return 1;
    if (((x) == cptr.ldI16(u) && (y) == cptr.ldI16o(u, 2) ? 1 : 0)) {
        for (otmp = cptr.ldPtro(gi, 8); otmp; otmp = cptr.ldPtr(otmp))
            if ((cptr.ldI16o((otmp), 32) == NHC.LARGE_BOX || cptr.ldI16o((otmp), 32) == NHC.CHEST ? 1 : 0) && (cptr.ldI32o(otmp, 132) & 1) | 0 ? 1 : 0)
                return 1;
        if (cptr.ldPtro(u, 2424)) {
            for (otmp = cptr.ldPtro(cptr.ldPtro(u, 2424), 280); otmp; otmp = cptr.ldPtr(otmp))
                if ((cptr.ldI16o((otmp), 32) == NHC.LARGE_BOX || cptr.ldI16o((otmp), 32) == NHC.CHEST ? 1 : 0) && (cptr.ldI32o(otmp, 132) & 1) | 0 ? 1 : 0)
                    return 1;
        }
    }
    if ((mtmp = (cptr.ldPtro3(svl, x, 168, y, 8, 75600))) !== null)
        for (otmp = cptr.ldPtro(mtmp, 280); otmp; otmp = cptr.ldPtr(otmp))
            if ((cptr.ldI16o((otmp), 32) == NHC.LARGE_BOX || cptr.ldI16o((otmp), 32) == NHC.CHEST ? 1 : 0) && (cptr.ldI32o(otmp, 132) & 1) | 0 ? 1 : 0)
                return 1;
    return 0;
}

/** C ref: detect.c:182 — @param {CInt} ttyp @param {CInt} x @param {CInt} y @returns {CInt} */
export function trapped_door_at(ttyp, x, y) {
    let lev;
    if (!((glyph_at(x, y)) >= ((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0) && (glyph_at(x, y)) < (((((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)) + ((NHC.TRAPNUM - 1) | 0)) | 0) ? 1 : 0))
        return 0;
    if (ttyp != NHC.TRAPPED_DOOR || ((cptr.ldI64o2(u, NHC.HALLUC, 24, 128) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 128) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, 112) ? 1 : 0) ? 1 : 0) && (rng_log_enabled() ? (rng_log_set_caller(__sl0, 188, __sl2), rn2(20)) : rn2(20)) ? 1 : 0) ? 1 : 0)
        return 0;
    lev = cptr.add(cptr.add(cptr.add(svl, 1680), x, 756), y, 36);
    if (!((cptr.ld1so(lev, 4)) == NHC.DOOR))
        return 0;
    if ((((cptr.ldI32o(lev, 8) & 31) | 0) & 3) != 0 && trapped_chest_at(ttyp, x, y) ? 1 : 0)
        return 0;
    return 1;
}
```

### after

```js
/** C ref: detect.c:122 — @param {CPtr} mtmp @param {CInt} showtail */
function map_monst(mtmp, showtail) {
    let glyph = ((cptr.ld1so(def_monsyms, cptr.ld1so((cptr.ldPtro(mtmp, FLD.monst_data)), FLD.permonst_mlet), 24)) == 32) ? (((Hallucination() ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), FLD.monst_data)), FLD.permonst_pmidx))) + ((((cptr.ldI32o((mtmp), FLD.monst_female) & 1) | 0) == 0) ? NHC.GLYPH_DETECT_MALE_OFF : NHC.GLYPH_DETECT_FEM_OFF)) | 0) : (cptr.ld1so(mtmp, FLD.monst_mtame) ? (((Hallucination() ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), FLD.monst_data)), FLD.permonst_pmidx))) + ((((cptr.ldI32o((mtmp), FLD.monst_female) & 1) | 0) == 0) ? NHC.GLYPH_PET_MALE_OFF : NHC.GLYPH_PET_FEM_OFF)) | 0) : (((Hallucination() ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), FLD.monst_data)), FLD.permonst_pmidx))) + ((((cptr.ldI32o((mtmp), FLD.monst_female) & 1) | 0) == 0) ? NHC.GLYPH_MON_MALE_OFF : NHC.GLYPH_MON_FEM_OFF)) | 0));
    show_glyph(cptr.ldI16o(mtmp, FLD.monst_mx), cptr.ldI16o(mtmp, FLD.monst_my), glyph);
    if (showtail && cptr.eq(cptr.ldPtro(mtmp, FLD.monst_data), cptr.add(mons, NHC.PM_LONG_WORM, 96)))
        detect_wsegs(mtmp, 0);
}

/** C ref: detect.c:139 — @param {CInt} ttyp @param {CInt} x @param {CInt} y @returns {CInt} */
export function trapped_chest_at(ttyp, x, y) {
    let mtmp;
    let otmp;
    if (!((glyph_at(x, y)) >= ((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0) && (glyph_at(x, y)) < (((((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)) + ((NHC.TRAPNUM - 1) | 0)) | 0)))
        return 0;
    if (ttyp != NHC.TRAPPED_CHEST || (Hallucination() && (rng_log_enabled() ? (rng_log_set_caller(__sl0, 146, __sl1), rn2(20)) : rn2(20))))
        return 0;
    if (sobj_at(NHC.CHEST, x, y) || sobj_at(NHC.LARGE_BOX, x, y))
        return 1;
    if (((x) == cptr.ldI16(u) && (y) == cptr.ldI16o(u, FLD.you_uy))) {
        for (otmp = cptr.ldPtro(gi, FLD.instance_globals_i_invent); otmp; otmp = cptr.ldPtr(otmp))
            if ((cptr.ldI16o((otmp), FLD.obj_otyp) == NHC.LARGE_BOX || cptr.ldI16o((otmp), FLD.obj_otyp) == NHC.CHEST) && (cptr.ldI32o(otmp, FLD.obj_otrapped) & 1) | 0)
                return 1;
        if (cptr.ldPtro(u, FLD.you_usteed)) {
            for (otmp = cptr.ldPtro(cptr.ldPtro(u, FLD.you_usteed), FLD.monst_minvent); otmp; otmp = cptr.ldPtr(otmp))
                if ((cptr.ldI16o((otmp), FLD.obj_otyp) == NHC.LARGE_BOX || cptr.ldI16o((otmp), FLD.obj_otyp) == NHC.CHEST) && (cptr.ldI32o(otmp, FLD.obj_otrapped) & 1) | 0)
                    return 1;
        }
    }
    if ((mtmp = (cptr.ldPtro3(svl, x, 168, y, 8, FLD.instance_globals_saved_l_level + FLD.dlevel_t_monsters))) !== null)
        for (otmp = cptr.ldPtro(mtmp, FLD.monst_minvent); otmp; otmp = cptr.ldPtr(otmp))
            if ((cptr.ldI16o((otmp), FLD.obj_otyp) == NHC.LARGE_BOX || cptr.ldI16o((otmp), FLD.obj_otyp) == NHC.CHEST) && (cptr.ldI32o(otmp, FLD.obj_otrapped) & 1) | 0)
                return 1;
    return 0;
}

/** C ref: detect.c:182 — @param {CInt} ttyp @param {CInt} x @param {CInt} y @returns {CInt} */
export function trapped_door_at(ttyp, x, y) {
    let lev;
    if (!((glyph_at(x, y)) >= ((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0) && (glyph_at(x, y)) < (((((NHC.GLYPH_CMAP_B_OFF + ((NHC.S_arrow_trap - NHC.S_grave) | 0)) | 0)) + ((NHC.TRAPNUM - 1) | 0)) | 0)))
        return 0;
    if (ttyp != NHC.TRAPPED_DOOR || (Hallucination() && (rng_log_enabled() ? (rng_log_set_caller(__sl0, 188, __sl2), rn2(20)) : rn2(20))))
        return 0;
    lev = cptr.add(cptr.add(cptr.add(svl, FLD.instance_globals_saved_l_level), x, 756), y, 36);
    if (!((cptr.ld1so(lev, FLD.rm_typ)) == NHC.DOOR))
        return 0;
    if ((((cptr.ldI32o(lev, FLD.rm_flags) & 31) | 0) & 3) != 0 && trapped_chest_at(ttyp, x, y))
        return 0;
    return 1;
}
```

and the name that made the difference, in `js/generated/nhprop.js`:

```js
/** C: include/youprop.h — the `Hallucination` macro body */
export function Hallucination() { return (cptr.ldI64o2(u, NHC.HALLUC, 24, FLD.you_uprops + FLD.prop_intrinsic) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, FLD.you_uprops + FLD.prop_intrinsic) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, FLD.you_uprops)) ? 1 : 0); }
```

`trapped_chest_at`'s first line is what is *left*: `glyph_is_trap()` is a
function-like macro, and §5 says why it is not in this leg.

---

## 1. `? 1 : 0` elision in truth position

C11 6.5.13/14 make `a && b` an int 0 or 1; JS's `&&` yields the raw operand.
The emitter has therefore always written `... ? 1 : 0` around every logical
operator, because the difference is real wherever the value is stored or does
arithmetic (`boolean()` narrowing it to a byte, an `int` field taking it).

It is dead weight wherever the value is only ever tested for truth, and that is
where the overwhelming majority of them land.

A logical-operator descriptor now carries `boolRaw`, holding *both* the
normalized code it emitted and the bare form. `asBool()` hands back the bare
form; `condExpr()` is the single entry point for consumers that need only
truth:

* `if`, `while`, `for`, `do`-`while` conditions — both the plain emitters and
  the state-machine ones (`emitSMIf`, `emitSMLoop`);
* the operand of `!`;
* the condition of `?:`;
* both operands of another logical operator — those are *unconditionally*
  bare, since `a && b` tests `a` for truth and returns `b`, so neither operand's
  own normalization can be observed no matter what the result feeds.

Everything else keeps the ternary. C semantics stay sacred: a value that flows
into arithmetic or storage is still an int 0 or 1.

### the staleness guard

`asBool()` swaps in the bare form only when `boolRaw.code === d.code`.

The emitter respreads descriptors constantly — `{...inner, code: ...}` in
`expr_ParenExpr`, `expr_ImplicitCastExpr`, `narrowBitfield`, `convert` — and a
`boolRaw` carried across such a respread would describe code that is no longer
there. Comparing the stored code makes that inert rather than wrong: a
value-preserving respread (a widening cast, a transparent `LValueToRValue`)
leaves the code string identical and stays elidable; anything that rewrites the
code falls back to the normalized form. `expr_ParenExpr` re-wraps `boolRaw`
explicitly, so `if ((a && b))` elides too.

**29,824 sites → 1,484.** `C2JS_BOOLCTX=0` restores the old emission and
reproduces the pre-change trees byte-for-byte.

---

## 2. Named struct field offsets — `js/generated/nhfield.js`

`cptr.ldPtro(mtmp, 8)` says nothing. `cptr.ldPtro(mtmp, FLD.monst_data)` says
what is being read, in the vocabulary of the C struct — which is the vocabulary
a NetHack 5.1 merge moves. A struct change becomes a readable diff of one
generated file instead of renumbered integers scattered through 170 modules.

**150,267 sites, 2,730 distinct offsets, 167 of 170 modules.**

### the decision: named constants, not accessor functions

The brief allowed either `M.data(mtmp)`-style generated per-struct accessors or
named offset constants. Constants won, on the perf guard.

A struct field read is the single hottest shape in the port — 150k of them, in
`vision.c`, `display.c`, `monmove.c`, the map loops. An accessor function puts a
call on every one of those; a named constant puts a module-namespace load of an
immutable binding, which V8 folds, on every one of those. `NHC.*` already
proved that shape free at ~40k sites in the 1.8/1.9 legs. It was not worth
spending the whole slope budget to save the `cptr.ldPtro(...)` spelling, which
a reader of this codebase already reads fluently.

Named offsets also compose in a way accessors do not: a two-level field path
reads as the path (`FLD.you_uprops + FLD.prop_intrinsic`) rather than as a
nested call.

### where the names come from, and what refuses one

Offsets come from the emitter's own `layoutOf()`, so this adds no new source of
truth. What it needs is a table that means the same thing in every module,
because they share one `nhfield.js`. `collectFieldOffsets()` in `build.mjs`
computes it once for the corpus, before any file is emitted — which also keeps
incremental builds honest, since a file whose emission is skipped still has its
`FLD.*` references resolved by the module.

A name is refused when

* two translation units disagree about its offset (a file-local struct
  shadowing a header one), or
* two different `(record, field)` pairs would spell it the same way —
  `record_field` is not an injective encoding on its own, and a name that could
  mean two things is exactly the "wrong name on a right value" the 1.9 tier
  refuses, or
* the record is anonymous: the emitter's internal keys (`anon#123`,
  `byloc#12:5`) are not identifiers, so those fields keep bare offsets.

**1,604 of 4,334 candidate names were refused; 2,730 survive.** At each site the
name is used only if the table's offset equals the one the emitter just
computed — the same equality audit as 1.9.

### the address algebra had to learn to fold through a name

`decomposeAddress`/`mergeConstAdd`/`fuseOffsetAccess` matched displacement
arguments with a digit-string regex. Left alone, a named offset would have
stopped `cptr.add(cptr.add(p, A), B)` from merging and would have made a
one-component address look like a subscript term, changing which fused accessor
was chosen — a real, silent performance regression dressed as a cosmetic
change.

`intOf()` resolves a literal *or* a registered name to its value, and
`sumCode()` re-spells a sum of displacements in written order. Verified
invariant against the pre-change tree:

| | before | after |
|---|---|---|
| `cptr.add(cptr.add(` (unmerged chains) | 483 | 483 |
| fused `o2`/`o3` accessors | 13,873 | 13,873 |
| fused `o` accessors | 127,366 | 127,366 |

Not one merge lost, not one accessor shape changed.

`C2JS_FIELDNAMES=0` restores bare integers and reproduces the pre-change trees
byte-for-byte.

### what stays numeric

Array *strides* (`cptr.ldPtro3(svl, x, 168, y, 8, ...)`, the `24` in
`cptr.ldI64o2(u, NHC.HALLUC, 24, ...)` which is `sizeof(struct prop)`) come from
`sizeofType`/`layoutOf(...).size`, not from a field, and are left for a later
pass; they are a much smaller surface than the offsets and want a different
name shape (`sizeof_prop`, not `record_field`).

---

## 3. Macro-body helpers — `js/generated/nhprop.js`

`Hallucination` is one word in C and 240 characters of inlined loads here,
repeated at every one of its sites.

The 1.9 macro tier could not reach it. That tier recovered a name from the
spelling location of the single integer token a macro expanded to; an
expression body has no single token, which is exactly why 1.9 listed
"macros whose body is an expression" under *what stays numeric*.

### the extent is the handle

What identifies an expression body is not a token but its **extent**. A node
whose `range.begin` and `range.end` spell at the first and last token of one
object-like `#define`'s body *is* that macro's complete expansion and nothing
else:

* a sub-expression of the body starts later or ends earlier;
* a use of the macro inside another macro's body spells at the inner body;
* C makes a preprocessor directive own its line, so two macros can never share
  the key.

Worked example, `detect.c:146` — `if (ttyp != TRAPPED_CHEST || (Hallucination && rn2(20)))`:

```
ParenExpr   begin.spellingLoc  youprop.h offset 5002   end.spellingLoc  offset 5039
                               ^ '(' of  #define Hallucination (HHallucination && !Halluc_resistance)
                                                                ^                                   ^
                                                              5002                                5039
```

and the scanner, reading `include/youprop.h` on its own, produces
`youprop.h:5002 → {name: 'Hallucination', end: 5039}`. The two agree exactly;
nothing was inferred from the value.

Offsets rather than `(line, col)` because clang prints an `offset` on every
location and omits `line` whenever it has not changed since the last location
it printed — the same inherited-location problem that cost the 1.9 tier half
its candidate sites.

`scanMacroExprDefs()` in `build.mjs` indexes every object-like `#define` in
`nethack-c/recorder/include/*.h` whose body is more than a single integer token
(those belong to `nhmacro.js`): **970 macros**, of which **200** are
`youprop.h`'s property tests.

### the audit is string equality

The body is emitted normally, and the call substituted only if that emission is
character-for-character the one already recorded for the name. That is what
makes the substitution safe with no scope analysis at all: a site where a
local shadows a global the body reads emits different code and keeps its
expansion.

The one hole equality does not close is a local *of the same name as the
global*, which emits the same string — so free identifiers are additionally
required not to be locals at the site.

A body may hold only pure loads off module-scope storage:

* no calls but `cptr.*` — so no side effects, no evaluation-order question, and
  nothing for the yieldable build to colour;
* no assignment, no `++`/`--`;
* no interned string literal, which would leave a dangling `__slN` in a file
  whose output no longer mentions it;
* no `rng_log_set_caller`, which carries the *call site's line number* and so
  could never have been shared anyway;
* no function designators (`#define dlb_fclose fclose` is an alias, not a
  body), and no body that is a bare identifier — an alias names nothing new.

### flat, not nested

Substitution is suppressed while a body is being captured, so every helper is a
leaf: `Hallucination()` is one call, not three (`HHallucination()`,
`HHalluc_resistance()`, `EHalluc_resistance()`). Nesting reads better inside
`nhprop.js` and costs three calls where the hot path has one. The hot path won.

### imported by bare name

`NHC`, `NHM` and `FLD` are namespaces because a C local can shadow an enum
constant or a `#define` name, and a member access cannot be shadowed. That
argument does not apply here: a C identifier cannot be named after a *live*
object-like macro, because the preprocessor would have expanded that
identifier. So the helpers import as `import { Hallucination } from
'./nhprop.js'` and read exactly like the C. `assemble()` asserts the imported
names do not collide with anything the file declares.

`decl.js` keeps its expansions inline: it is the globals hub of a giant import
cycle and is deliberately kept a leaf of it, and `nhprop.js` reads those
globals.

**214 helpers, 4,968 call sites.** `C2JS_MACROFNS=0` disables the substitution
and reproduces the pre-change trees byte-for-byte.

---

## 4. Perf: the interleaved A/B

<!--PERF-->

---

## 5. Function-like macros (class 4) — designed, deferred

`glyph_is_trap(glyph_at(x, y))` is the ugliness still visible in
`trapped_chest_at`'s first line, and the mechanism to name it is a short step
from §3: the extent test already identifies a function-like macro's expansion,
and a sub-node whose `range.begin.spellingLoc` lands in the *.c file* rather
than the macro body is an argument spelled at the call site. Emitting the body
with those replaced by parameters, then checking that substituting the
arguments' own emissions back into that body reproduces the original string
character-for-character, is the same audit §3 uses and is just as decisive.

It is deferred because of **multiple evaluation**, which is not a style
question here:

```c
#define glyph_is_trap(g) ((g) >= GLYPH_CMAP_B_OFF + (S_arrow_trap - S_grave) \
                       && (g) <  GLYPH_CMAP_B_OFF + (S_arrow_trap - S_grave) + (TRAPNUM - 1))
```

C expands `g` twice, so `glyph_is_trap(glyph_at(x, y))` calls `glyph_at` twice
— which is why the emitted code calls it twice today. A helper taking one
parameter calls it once. In a program scored on an exact PRNG trace, changing
how many times a function runs is a parity change, not an optimization, and it
would be one the corpus might not catch (`glyph_at` happens not to draw from
the RNG; the next such macro might).

Landing it needs one of: proving the argument side-effect-free at emit time
(then a single evaluation is unobservable), or restricting to macros that use
each parameter exactly once. Both are tractable; neither is a change to make
in the same leg as three others, and the audit for "side-effect-free" is a
larger piece of machinery than everything in §1–§3 combined.

---

## 6. Gates

<!--GATES-->

---

## 7. Commits

<!--COMMITS-->
