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
    let glyph = ((cptr.ld1so(def_monsyms, cptr.ld1so((cptr.ldPtro(mtmp, $monst_data)), $permonst_mlet), 24)) == 32) ? (((Hallucination() ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), $monst_data)), $permonst_pmidx))) + ((((cptr.ldI32o((mtmp), $monst_female) & 1) | 0) == 0) ? NHC.GLYPH_DETECT_MALE_OFF : NHC.GLYPH_DETECT_FEM_OFF)) | 0) : (cptr.ld1so(mtmp, $monst_mtame) ? (((Hallucination() ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), $monst_data)), $permonst_pmidx))) + ((((cptr.ldI32o((mtmp), $monst_female) & 1) | 0) == 0) ? NHC.GLYPH_PET_MALE_OFF : NHC.GLYPH_PET_FEM_OFF)) | 0) : (((Hallucination() ? ((rn2_on_display_rng)(NHC.NUMMONS)) : (cptr.ldI32o((cptr.ldPtro((mtmp), $monst_data)), $permonst_pmidx))) + ((((cptr.ldI32o((mtmp), $monst_female) & 1) | 0) == 0) ? NHC.GLYPH_MON_MALE_OFF : NHC.GLYPH_MON_FEM_OFF)) | 0));
    show_glyph(cptr.ldI16o(mtmp, $monst_mx), cptr.ldI16o(mtmp, $monst_my), glyph);
    if (showtail && cptr.eq(cptr.ldPtro(mtmp, $monst_data), cptr.add(mons, NHC.PM_LONG_WORM, 96)))
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
    if (((x) == cptr.ldI16(u) && (y) == cptr.ldI16o(u, $you_uy))) {
        for (otmp = cptr.ldPtro(gi, $instance_globals_i_invent); otmp; otmp = cptr.ldPtr(otmp))
            if ((cptr.ldI16o((otmp), $obj_otyp) == NHC.LARGE_BOX || cptr.ldI16o((otmp), $obj_otyp) == NHC.CHEST) && (cptr.ldI32o(otmp, $obj_otrapped) & 1) | 0)
                return 1;
        if (cptr.ldPtro(u, $you_usteed)) {
            for (otmp = cptr.ldPtro(cptr.ldPtro(u, $you_usteed), $monst_minvent); otmp; otmp = cptr.ldPtr(otmp))
                if ((cptr.ldI16o((otmp), $obj_otyp) == NHC.LARGE_BOX || cptr.ldI16o((otmp), $obj_otyp) == NHC.CHEST) && (cptr.ldI32o(otmp, $obj_otrapped) & 1) | 0)
                    return 1;
        }
    }
    if ((mtmp = (cptr.ldPtro3(svl, x, 168, y, 8, $instance_globals_saved_l_level + $dlevel_t_monsters))) !== null)
        for (otmp = cptr.ldPtro(mtmp, $monst_minvent); otmp; otmp = cptr.ldPtr(otmp))
            if ((cptr.ldI16o((otmp), $obj_otyp) == NHC.LARGE_BOX || cptr.ldI16o((otmp), $obj_otyp) == NHC.CHEST) && (cptr.ldI32o(otmp, $obj_otrapped) & 1) | 0)
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
    lev = cptr.add(cptr.add(cptr.add(svl, $instance_globals_saved_l_level), x, 756), y, 36);
    if (!((cptr.ld1so(lev, $rm_typ)) == NHC.DOOR))
        return 0;
    if ((((cptr.ldI32o(lev, $rm_flags) & 31) | 0) & 3) != 0 && trapped_chest_at(ttyp, x, y))
        return 0;
    return 1;
}
```

and the name that made the difference, in `js/generated/nhprop.js`:

```js
/** C: include/youprop.h — the `Hallucination` macro body */
export function Hallucination() { return (cptr.ldI64o2(u, NHC.HALLUC, 24, $you_uprops + $prop_intrinsic) && !(cptr.ldI64o2(u, NHC.HALLUC_RES, 24, $you_uprops + $prop_intrinsic) || cptr.ldI64o2(u, NHC.HALLUC_RES, 24, $you_uprops)) ? 1 : 0); }
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

**29,824 sites → 1,493** — 26,281 logical results emitted bare, and no
descriptor ever hit the staleness guard with a mismatched code string, i.e.
the elision was never *silently* declined. `C2JS_BOOLCTX=0` restores the old
emission and reproduces the pre-change trees byte-for-byte.

---

## 2. Named struct field offsets — `js/generated/nhfield.js`

`cptr.ldPtro(mtmp, 8)` says nothing. `cptr.ldPtro(mtmp, $monst_data)` says
what is being read, in the vocabulary of the C struct — which is the vocabulary
a NetHack 5.1 merge moves. A struct change becomes a readable diff of one
generated file instead of renumbered integers scattered through 170 modules.

**137,788 named offset emissions, 2,730 distinct offsets, 167 of 170 modules.**
(The tree carries ~150,300 `$name` spellings: the emissions plus the per-file
preamble bindings introduced below.) 974 sites kept a bare integer.

### the decision: named constants, not accessor functions

The brief allowed either `M.data(mtmp)`-style generated per-struct accessors or
named offset constants. Constants won, on the perf guard.

A struct field read is the single hottest shape in the port — 150k of them, in
`vision.c`, `display.c`, `monmove.c`, the map loops. An accessor function puts
a call on every one of those. It was not worth spending the whole slope budget
to save the `cptr.ldPtro(...)` spelling, which a reader of this codebase
already reads fluently.

Named offsets also compose in a way accessors do not: a two-level field path
reads as the path (`$you_uprops + $prop_intrinsic`) rather than as a nested
call.

### the spelling, and why it is not `FLD.monst_data`

This first shipped as `FLD.monst_data`, a namespace load like `NHC.*` and
`NHM.*` before it. **The A/B rejected it: +8.1%.** (§4 has the numbers.)

A microbenchmark isolated the cause — 24M loads of an offset passed as an
argument:

| | ms |
|---|---|
| integer literal | 21.4 |
| module-scope `const`, from a literal | 22.2 |
| module-scope `const`, from `NS.x` | 22.0 |
| module-namespace `NS.x` | 25.8 |

V8 constant-folds a module-scope `const`; it does not fold a module-namespace
load, which stays a cell load with its own feedback slot. Named imports
(`import { monst_data }`) measured *worse* than the namespace — 33.6 ms — so
the fix was never the import form. It is binding the value into the module.

A file therefore spells the offset `$monst_data`, bound once in a preamble:

```js
import * as FLD from './nhfield.js';
// struct field offsets used below, bound at module scope so V8 folds them
// (values from ./nhfield.js, which is the whole table)
const $monst_data = FLD.monst_data, $monst_female = FLD.monst_female, ...;
```

`nhfield.js` remains the single source of truth — the binding is a fold hint,
not a second table — and the preamble reads as a useful summary of which struct
fields the module touches.

The `$` prefix is load-bearing, not decoration. A C identifier cannot contain
`$`, so (a) nothing the emitter emits for C code can shadow the binding, and
(b) the address algebra's `NAMED_INTS` lookup, which is keyed by the *emitted
string*, can never mistake some file's local variable for a constant offset.
That second hazard became real the moment the offsets stopped being
namespace-qualified, and the prefix is what closes it by construction rather
than by a check that could be forgotten.

`reset-census` learns `FLD.x` as a `constref` — as immutable as `NHC.x` — and
its plan count now asks the same question `resetify`'s `planFor()` does, so the
13,412 new `const` scalars do not read as 13,412 more things to put back. The
plan is 1,416 and resetify still emits 1,395 bindings.

### where the names come from, and what refuses one

Offsets come from the emitter's own `layoutOf()`, so this adds no new source of
truth. **The layout is the emitter's own, not the host C ABI's**: it only has
to be self-consistent inside the port, and nothing outside the port reads it.
What the table needs is a name that means the same thing in every module,
because they share one `nhfield.js`. `collectFieldOffsets()` in `build.mjs`
computes it once for the corpus, before any file is emitted — which also keeps
incremental builds honest, since a file whose emission is skipped still has its
offsets resolved by the module.

A name is refused when

* two translation units disagree about its offset (a file-local struct
  shadowing a header one), or
* two different `(record, field)` pairs would spell it the same way —
  `record_field` is not an injective encoding on its own, and a name that could
  mean two things is exactly the "wrong name on a right value" the 1.9 tier
  refuses.

Anonymous records never enter the table at all: the emitter's internal keys
(`anon#123`, `byloc#12:5`) are not identifiers, so their fields keep bare
offsets.

In this corpus **nothing was refused on either count** — no two TUs disagree
about a field's offset, and no two `(record, field)` pairs collide on a name.
The checks stay because a 5.1 merge is exactly the event that would introduce
one, and a silently wrong name is the failure mode this whole tier exists to
avoid. The table offers **4,334** names; emitted code references **2,730** of
them.

At each site the name is used only if the table's offset equals the one the
emitter just computed — the same equality audit as 1.9. **974 sites kept a bare
integer**, all of them fields of anonymous records, whose emitter-internal keys
never entered the table.

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

`C2JS_FIELDNAMES=0` restores bare integers; with all three flags off the build
reproduces `524c52d` byte-for-byte (only the two new modules, empty, remain).

### what stays numeric

Array *strides* (`cptr.ldPtro3(svl, x, 168, y, 8, ...)`, the `24` in
`cptr.ldI64o2(u, NHC.HALLUC, 24, ...)`, which is `sizeof(struct prop)`) come from
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
global*, which emits the same string. So free identifiers are additionally
required not to be locals — and that check runs at **every** site, not only at
the one whose emission was captured. A helper resolves its free names once, at
`nhprop.js`'s own scope, on behalf of everyone who calls it; a site where one
of those names means a local is a site where the helper would quietly read the
wrong storage, and string equality cannot see it.

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

**214 helpers, 4,972 call sites** — with 267 expansions refused as impure and
80 refused because a site's own emission of the body did not match. `C2JS_MACROFNS=0` disables the substitution
and reproduces the pre-change trees byte-for-byte.

---

## 4. Perf: the interleaved A/B

The guard for this leg was ±2% on the **slope** — `ps_test_runner`'s fitted
per-move cost across all 69 sessions, which is the number that separates
per-move work from startup. Four states, interleaved ABBA, three rounds:

| state | median slope | min | vs base |
|---|---|---|---|
| `524c52d` baseline | 0.5430 | 0.5391 | — |
| + `? 1 : 0` elision | 0.5357 | 0.5319 | **−1.3%** |
| + named field offsets | 0.5471 | 0.5301 | +0.8% |
| + macro-body helpers (shipped) | 0.5447 | 0.5423 | **+0.3%** |

Per class: elision **−1.3%**, offsets **+2.1%** (median) or **−0.3%** (min),
helpers **−0.4%** (median) or **+2.3%** (min). The two statistics disagree
about which of the last two carries the residual, and in three of the twelve
runs a later state came out *faster* than a strictly smaller one — which is the
honest summary: once the offsets are bound at module scope, no class is
separable from the noise floor, and the total is **+0.3%**.

Startup moves the other way and is real: **833–864 ms → 892–971 ms**, about
+6%, which is what +19.5% of source bytes to parse costs. Startup was not the
guard, but it is the price and §6 states it.

### how it was measured, and what the first attempt got wrong

Every state swaps **both** `js/generated` and `js/generated-y`. Swapping only
the sync build looks like it should work and does not: the scoring path reads a
consistent pair, and a mixed one failed 5 of 69 sessions on the baseline and 24
on one variant — numbers that would have been read as a parity regression
rather than as a broken harness.

The machine is shared and drifts: across one earlier sitting the same tree
measured 0.61 and then 0.89 ms/move an hour apart. So each state is measured
inside every round, the round's direction alternates so a monotone drift
cancels, and both median and min are reported — a single number from a single
run proves nothing here, and one contaminated round (visible in the third,
where two states jumped 20%) should be visible rather than averaged away.

The first attempt at this used the three longest sessions and total
ms/move — cheaper, but it folds each session's startup into the per-move
figure, which is exactly the term this change makes worse. That is what put
the field offsets at +2.3% there and +0.8% here.

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

Run at `f40cf98`, after `C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs --all --force`.

| gate | result |
|---|---|
| batch build | 172 files: 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; **0 parse failures** |
| `C2JS_FOLD_VERIFY=1` | **301,692 folds, 0 mismatched, 0 unevaluable** (unchanged from 1.9) |
| full rebuild reproduces the committed trees | **byte-identical** — `js/generated`, `js/generated-y`, both reset barrels and `js/boot/harness-y.mjs` |
| all three flags off reproduces `524c52d` | **byte-identical**, except the two new modules (which come out empty) |
| `reset-census` | 178 modules, 45,881 declarations, plan 1,416, **0 unclassified** |
| corpus (`sessions/` + `sessions-extra/`), twice | **69/69** and **69/69** (859+0.53/turn, 832+0.53/turn) |
| `reset-diff --via runsegment` | **12/12** pairs byte-identical to a fresh realm |
| `tools/c2js/test-rnd.mjs` | PASS (2,983/2,983 RNG calls) |
| `tools/c2js/test-hacklib.mjs` | PASS — 870 cases, 0 failures |
| `tools/c2js/test-setjmp.mjs`, `test-union.mjs` | PASS |
| `node --test test/*.test.mjs` | **6/6** (cmachine, libc-string, lua-port-data, lua-port-scripts, posix-ere, printf) |
| `tools/strict-score.mjs` | 507 files reachable from 2 roots, **0 violations** |
| `judge-sim/run.mjs` seed8000, seed0013 | **PASS**, 0 segment mismatches, 0 out-of-scope requests |
| `judge-sim/playability.mjs --their-page --seed=1` | 130 moves, 350 requests, 0 out-of-scope, 0 404s, **0 console entries** |
| sandboxed `playability_runner.mjs` (`node --permission`) | 44 sessions, **0 failures**, 9,096 moves, **3.15 ms/move** (documented baseline 3.03–3.08) |
| bare-`NHC`/`NHM`/`FLD` collision scan, helper-name collision scan | 0 hits |

### size

`js/generated` grows **13,363,515 → 15,975,697 bytes (+19.5%)**. Roughly half is
the field-offset names themselves (`$instance_globals_saved_l_level` is 30
characters where `1680` was four) and half the per-file preambles. The two new
modules are 108 KB (`nhfield.js`) and 47 KB (`nhprop.js`).

That is the real price of this leg, and it is paid in bytes rather than in
time. It is worth stating plainly rather than burying: `? 1 : 0` elision gives
some of it back, but not most of it.

---

## 7. Commits

* `3eb81f0` — `? 1 : 0` elision in truth position.
* `87b4730` — named struct field offsets, `js/generated/nhfield.js`.
* `82c30e5` — macro-body helpers, `js/generated/nhprop.js`.
* `f40cf98` — bind the offsets at module scope, after the A/B rejected the
  namespace spelling.
* `5d06d94` — re-check a helper's free names for shadowing at every site
  (output-neutral: 0 sites affected, trees byte-identical to `f40cf98`).

On `readability-1`, off `main` at `524c52d`. Nothing pushed, nothing merged.
`js/generated` must be committed from a **normal** build, never a
`C2JS_FOLD_VERIFY=1` one — that mode re-emits through the real emitter methods
and sets `usesConsts` on one extra file (pre-existing, see 1.8).

---
---

# Readability, leg 2 — the source tier (roadmap 1.13)

Branch `readable-2`, off `main` at `0e5980d`. Seven changes, and the rule
governing all of them is the project owner's:

> The goal is to make a source transpiler; we cannot randomly insert meaning
> where previously none existed.

So every name and every comment below is **recovered** from the C — from the
AST, from the layout the emitter already computes, or from the C source text —
and where a thing cannot be recovered it keeps its integer and is counted.
Leg 1 (§1–§7 above) gave the code back the vocabulary of C's *values*; this leg
gives it back the vocabulary of the C *source*: its types, its literals, its
sizes, and its author's own commentary.

| flag | default | what the other setting does |
|---|---|---|
| `C2JS_PTRDOC=0` | on | bare `@param {CPtr}` again (§11) |
| `C2JS_STRNAMES=0` | on | `__slN` string-table names again (§10) |
| `C2JS_SIZENAMES=0` | on | bare integer element sizes and strides (§12) |
| `C2JS_RNGFOLD=0` | on | the inline rng-log ternary at every draw (§13) |
| `C2JS_COMMENTS=0` | on | drop the C's comments (§9) |
| `C2JS_BLANKLINES=0` | on | drop the C's blank lines (§9) |

---

## 8. The acceptance demo

### before (`0e5980d`)

```js
/** C ref: detect.c:139 — @param {CInt} ttyp @param {CInt} x @param {CInt} y @returns {CInt} */
export function trapped_chest_at(ttyp, x, y) {
    let mtmp;
    let otmp;
    if (!glyph_is_trap(glyph_at(x, y)))
        return 0;
    if (ttyp != NHC.TRAPPED_CHEST || (Hallucination() && (rng_log_enabled() ? (rng_log_set_caller(__sl0, 146, __sl1), rn2(20)) : rn2(20))))
        return 0;
    if (sobj_at(NHC.CHEST, x, y) || sobj_at(NHC.LARGE_BOX, x, y))
        return 1;
    if (((x) == cptr.ldI16(u) && (y) == cptr.ldI16o(u, $you_uy))) {
        for (otmp = cptr.ldPtro(gi, $instance_globals_i_invent); otmp; otmp = cptr.ldPtr(otmp))
            if (Is_box(otmp) && (cptr.ldI32o(otmp, $obj_otrapped) & 1) | 0)
                return 1;
        ...
```

### after

```js
/* this is checking whether a trap symbol represents a trapped chest,
   not whether a trapped chest is actually present */
/** C ref: detect.c:139 — @param {CInt} ttyp @param {CInt} x @param {CInt} y @returns {CInt} */
export function trapped_chest_at(ttyp, x, y) {
    let mtmp;
    let otmp;

    if (!glyph_is_trap(glyph_at(x, y)))
        return 0;
    if (ttyp != NHC.TRAPPED_CHEST || (Hallucination() && rn2_at(__s_detect_c, 146, __s_trapped_chest_at, 20)))
        return 0;

    /*
     * TODO?  We should check containers recursively like the trap
     * detecting routine does.  Chests and large boxes do not nest in
     * themselves or each other, but could be contained inside statues.
     *
     * For farlook, we should also check for buried containers, but
     * for '^' command to examine adjacent trap glyph, we shouldn't.
     */

    /* on map, presence of any trappable container will do */
    if (sobj_at(NHC.CHEST, x, y) || sobj_at(NHC.LARGE_BOX, x, y))
        return 1;
    /* in inventory, we need to find one which is actually trapped */
    if (((x) == cptr.ldI16(u) && (y) == cptr.ldI16o(u, $you_uy))) {
        for (otmp = cptr.ldPtro(gi, $instance_globals_i_invent); otmp; otmp = cptr.ldPtr(otmp))
            if (Is_box(otmp) && (cptr.ldI32o(otmp, $obj_otrapped) & 1) | 0)
                return 1;
        ...
```

and `trapped_door_at`'s address line, where the two remaining magic numbers
were the strides:

```js
    lev = cptr.add(cptr.add(cptr.add(svl, $instance_globals_saved_l_level), x, 756), y, 36);   // before
    lev = cptr.add(cptr.add(cptr.add(svl, $instance_globals_saved_l_level), x, $sizeof_rm_x21), y, $sizeof_rm);
```

`dbridge.c`'s `do_entity` is the other half of the demo, because it is where
the C author's *layout* comes back — a staircase of trailing comments that
only makes sense read together:

```js
            pline(__s_s_crushed_underneath_the_drawbridge, E_phrase(etmp, __s_are));  /* no jump */
            e_died(etmp, NHM.XKILL_NOCORPSE | (e_inview ? NHM.XKILL_GIVEMSG : NHM.XKILL_NOMSG), NHC.CRUSHING);  /* no corpse */
            return;  /* Note: Beyond this point, we know we're  */
        }  /* not at an opened drawbridge, since all  */
        must_jump = 1;  /* *missable* creatures survive on the     */
    }  /* square, and all the unmissed ones die.  */
```

---

## 9. The C's comments, and its blank lines

`detect.c` has 377 comments. `detect.js` had 11, and all eleven were ours.
That is the largest body of recovered meaning still sitting in the source, and
clang throws every byte of it away before the emitter sees anything: a comment
is not an AST node, and no node carries a trace of one.

So the comments are read out of the C text, positioned by the same source
offsets `/** C ref: */` is already built from (`lineOf`, `range.begin`,
`range.end`).

### the unit is the line

A byte-offset gap between two statements contains the `;` that ended the first
one — clang's `range.end` points at the *start* of a node's last token — so an
offset rule would have to model token ends to know where a statement really
stopped. A line rule does not. It is also the rule task 6 needs, because a
blank line is a line.

### the classification, once per file

`scanTrivia()` walks the C text with a scanner that knows comments, string and
character literals, and C's backslash-newline splice, and classifies **every
line** as `code`, `blank` or `comment`:

* a comment with nothing but whitespace before it on its first line and
  nothing after it on its last is **movable**, and its lines are trivia;
* any other comment — one after code, one before code on the same line — is
  **not**, and its lines are marked `code` so nothing can harvest them. A
  comment after code on a single line is instead recorded as that line's
  *trailing* comment.
* a `//` comment continued with a backslash is refused outright: it is one
  comment in C and would be a comment plus a statement in JS. (0 in this
  corpus. The check is there because the failure would be silent and
  syntactic.)

### the attachment rule, and why it is right rather than merely near

A statement takes the **run of blank and comment lines immediately above its
first line, stopping at the first line with code on it.**

That bound is the whole argument. A comment cannot cross a line of code, so
the run above a statement can only ever be a comment the C author wrote about
*that* statement. It is also what protects a function's own doc comment from
being eaten by its first statement — the `{` is a line of code — and what
keeps a file's licence header out of the first declaration, since `#include`
lines sit in between.

A comment after the code on a statement's **last** line is appended to that
statement's last emitted line, which is what keeps `do_entity`'s staircase
readable.

A **declaration's** run goes above the whole chunk — above the hoisted statics
and above our `/** C ref: */` — so the C author's line reads as theirs and
ours reads as ours. The blank line the C puts above a declaration is dropped,
because `assemble()` already writes one there and two would read as a gap the
author did not leave.

Runs of blank lines collapse to one.

### dedup: a spliced region may not claim a comment twice

The goto lowerings and the setjmp split emit some regions more than once
(`emitLabeledItems`, `emitXBlockItems`, the try/catch pair in
`emitBlockItems`). A comment repeated in two copies of one region claims about
both what the C said about one, which is exactly the "wrong name on a right
value" failure in a different costume.

**Every trivia line is emitted at most once per function**, and the first copy
carries it: 1,671 lines declined a second time. The one place that has to
release its claim is the state-machine fallback, which re-emits a whole body
after an attempt that was thrown away — it clears the lines the discarded
attempt spent, or the final emission would come out bare.

### what is dropped, stated rather than hidden

* a comment inside a statement's own line span — inside a multi-line
  condition, between the arms of a `for` header — has no statement to attach
  to and is not carried;
* a comment in a region the emitter never emits (dead code the goto lowering
  suppresses, an `#if`-ed out block clang never parsed);
* the file header, for the `#include` reason above;
* 365 comments that share a line with code in a position that is neither
  leading nor trailing.

### the audit

Every carried comment line must appear **verbatim in that module's own C
source**, must not be carried more often than the C spells it, and must come
from the C region of the declaration it was emitted under.

**28,249 carried comment lines: 0 not found verbatim, 0 over-carried, 0 from
outside the declaration's region.** (The audit's own false positives were
three `lvm.js` comments whose enclosing `C ref:` marker the window heuristic
mis-bracketed, and the 37 lines of the hand-written runtime preludes, which
are not carried at all.)

**15,535 comments carried (6,554 of them trailing a statement) and 20,516
blank lines.**

---

## 10. String literals named by what they say

24,129 interned literals were called `__sl0` … `__sl24128` and referenced
58,151 times. The number is interning order — an artifact, and not even a
stable one: adding a literal upstream renumbers every literal after it, so a
one-word change to a `pline()` produced a diff across the file.

The name now comes from the literal's own bytes:

```js
rng_log_set_caller(__sl0, 146, __sl1)
rng_log_set_caller(__s_detect_c, 146, __s_trapped_chest_at)
```

### the rule

1. runs of non-alphanumeric characters collapse to `_`; the result is
   lower-cased and stripped of leading and trailing `_`;
2. a literal left with **fewer than two alphanumeric characters** — `": "`,
   `"%s"`, `"."`, `""` — is transliterated one character at a time instead
   (`__s_colon_sp`, `__s_pct_s`, `__s_dot`, `__s_empty`), with a run of one
   character carrying a count (`__s_sp10`). Rule 1 collapses these to nothing,
   so without rule 2 every punctuation literal would be the same name;
3. the slug is capped at **40 characters**, cut back to the last `_` past the
   eighth so a cap never lands mid-word;
4. a slug two distinct literals in one file produce is disambiguated by a
   `__2`, `__3`, … suffix on the later ones, in interning order. It is
   unambiguous because rule 1 collapses runs, so a slug can never itself
   contain a doubled underscore.

The escapes `cStringToJs` introduced are decoded before slugging, so a literal
is named by what it *is*: `"\033["` is `__s_esc_lbrack`, not `__s_x1b_lbrack`.

**23,585 named, 503 needed a collision suffix.**

### what is unchanged, and the one hazard

Identifier renaming only. The value of every literal, the dedup, and the order
of each file's string table are byte-for-byte what they were.

The hazard is that a C identifier may legally begin with `__s_`, and the
string table is emitted **above** the body — so a collision would be a silent
shadow, with every use reading the declaration rather than the literal.
`assemble()` therefore asserts that no string name collides with anything the
module declares. (No C identifier in this corpus begins with `__s_`; the two
that come closest are `__sgi` and `__sub`.)

`bundle.mjs`'s collision accounting learns the new spelling and keeps the old.
Cross-module renames fall **23,159 → 5,945**, because two modules no longer
both declare `__sl0`; the 16 that are real C symbols are unchanged.

---

## 11. A pointer parameter has a type

Every pointer parameter in the tree read `@param {CPtr} mtmp` — true, and
worth nothing. The AST spells it `struct monst *` and always did; `jsdocType`
collapsed every pointer to one word before anyone could see it.

```js
/** C ref: detect.c:122 — @param {CPtr<struct monst>} mtmp @param {CInt} showtail */
/** C ref: dbridge.c:286 — @param {CInt} x @param {CInt} y @returns {CPtr<struct entity>} */
```

The spelling inside the brackets is `qualType` — the C declaration's own
spelling — not the desugared form, because the point is to hand back the
vocabulary of the C: a `coordxy *` says `CPtr<coordxy>`, not `CPtr<short>`.
cv-qualifiers are dropped, since the port's memory model has no notion of them
and `CPtr<const char>` would claim something nothing enforces.

Three shapes decline the bracket and stay bare `CPtr`, each because the
spelling would be a claim the emitter cannot back:

* a pointee spelling with parentheses in it — a function pointer
  (`int (*)(int)`), and clang's anonymous-record spelling (`struct (unnamed
  struct at <file>:12:5)`). The second is also what keeps this tier out of the
  `__FILE__` hygiene problem **by construction**: no path can reach a comment
  because no parenthesized spelling does;
* a decayed array or function designator, which `parseType` calls a pointer
  and which has no pointee at all;
* anything over 40 characters.

**8,496 pointers carry their C pointee, 142 stayed bare.** Comments only: not
one emitted value changes.

---

## 12. Element sizes and strides — `sizeof_<record>` in `nhfield.js`

§2 named the *displacement* in an address and left the other integers alone:

```js
cptr.ld1so3(svl, x, 756, y, 36, $instance_globals_saved_l_level + $rm_typ)
cptr.add(mons, NHC.PM_LONG_WORM, 96)
```

says `levl[x][y].typ` and `mons[PM_LONG_WORM]` with three magic numbers in it.
They are real C quantities and the emitter computed each of them from the
layout it already has: **36 is `sizeof(struct rm)`**, **96 is
`sizeof(struct permonst)`**, and **756 is `sizeof(struct rm [21])`** — the
stride of one `levl` column, which decomposes exactly as `21 * sizeof_rm`.

```js
cptr.ld1so3(svl, x, $sizeof_rm_x21, y, $sizeof_rm, $instance_globals_saved_l_level + $rm_typ)
cptr.add(mons, NHC.PM_LONG_WORM, $sizeof_permonst)
```

### why nhfield.js and not a sibling

Same table (`layoutOf`), same conflict rules, same `$name` module-scope
binding for the same V8-folding reason §2 measured. A second module would have
been a second preamble and a second import for no distinction that exists.

A composed stride is **resolved arithmetically when the table is written** and
carries its own decomposition beside the value:

```js
export const sizeof_rm = 36;
export const sizeof_rm_x21 = 756;   // = 21 * sizeof_rm
```

so one entry per record covers every array bound the corpus reaches, and the
claim "756 is 21 of them" is written down rather than asserted in prose. The
equality audit reaches through the composition: a name is used at a site only
when `base × ∏counts` is exactly the size that emitter just computed.

A record whose own name ends `_x<digits>` is refused a size name from both
sides, since `sizeof_rm_x21` is also how an array of 21 `struct rm` spells
itself — §2's "a name that could mean two things" rule, applied before the two
spellings can meet.

### what deliberately keeps its integer

* a **pointer (8), a scalar (1/2/4/8) and an enum (4)**: machine widths, not
  NetHack's. `sizeof_int` would be a name for a fact no 5.1 merge can move,
  and there are 9,226 such sites. Naming them would be inserting meaning, not
  recovering it.
* the **count** in a stride. 21 is `ROWNO` in the C (`#define ROWNO 21`,
  global.h:383) — but the preprocessor consumed that name before clang saw the
  array bound, and 21 is the value of many macros. Recovering it from the
  value would be a guess. This leaves **381 sites** spelling a
  `struct monst *[21]` row stride as `168`, where both factors are machine
  widths and neither has a NetHack name.
* C-source `sizeof` expressions, which are values in the constant-folding path
  and are audited by `C2JS_FOLD_VERIFY` against an evaluator that binds only
  `NHC`/`NHM`. Naming them would make every one of those folds unevaluable.

**21,377 element sizes named and 1,912 composed strides**, over 2,945 exported
names of which 5 are composed. **23 record sizes refused by the equality
audit.** Of the 2,134 `o3` accesses, 422 keep a numeric stride; 381 of those
are the `[21]` pointer rows above.

---

## 13. The rng-log fold — `js/generated/nhrng.js`

The recorder's `hack.h` redefines every PRNG entry point to log its caller:

```c
#define rn2(x) (rng_log_enabled()                                    /* hack.h:1596 */
                ? (rng_log_set_caller(__FILE__, __LINE__, __func__), rn2(x))
                : rn2(x))
```

so where the C says `rn2(20)`, 2,724 sites in the port said

```js
(rng_log_enabled() ? (rng_log_set_caller(__s_detect_c, 146, __s_trapped_chest_at), rn2(20)) : rn2(20))
```

— the same eleven tokens every time, and the loudest thing on every line that
draws. It folds to

```js
rn2_at(__s_detect_c, 146, __s_trapped_chest_at, 20)
```

with the ternary written once per macro in `nhrng.js`. Six helpers: `rn2`,
`rnd`, `rnl`, `rne`, `rnz`, `d`.

### the log is scored

`getRngLog()` is what the judge reads. The helper therefore performs **exactly
the three calls the macro did, in the macro's order**, and nothing about the
log's content can move. Only the spelling of the call site changes.

### the recognition, and the two audits

Structural, on the AST, because the shape **is** the macro and nothing else in
NetHack tests `rng_log_enabled()`: the condition is a call to it, the then-arm
is a comma expression whose left is `rng_log_set_caller` with three arguments
and whose right is a draw, and the else-arm is the same draw. The two arms are
then required to emit **character-for-character the same call**, which is the
audit — the extent machinery of §3 could not be used here because the body
carries `__LINE__` and so emits differently at every site.

### what a call really changes, and the guard

Not how *many* times the argument runs — C spells it once per arm and exactly
one arm runs — but **when**. C evaluated it inside the selected arm, after
`rng_log_enabled()` and after `rng_log_set_caller`; a call evaluates it before
both.

A site is admitted only when the argument **neither writes nor draws**:
`macroFnArgSafe`, the same evidence tier 1.12 hoists on (no assignment, no
`++`/`--`, and every callee provably pure — which excludes the whole RNG by
construction). The case that must be refused is `rn2(rnd(3))`: with the
instrumentation inline the inner draw logs against the inner line and the
outer against it too, and with the argument hoisted they log against different
callers. That is a change to the scored artifact, and it is refused.

**2,679 of 2,724 folded; 45 refused** — `rn2(++chcnt)`, `rnd(tmp = tmp / 2)`,
`rn2(acurr(A_DEX))`, `rn2(d_at(...))`.

`nhrng.js` imports `rnd.js`, which imports `decl.js`, so neither of those two
may fold a site or the helper module joins its own import cycle. `rnd.c`
cannot (hack.h's `RNGLOG_IN_RND_C` suppresses the macros there) and `decl.c`
happens never to draw — asserted at assemble time rather than discovered at
load time.

---

## 14. The generated modules carry provenance, not commentary

Five generated sidecars carried authored prose headers — paragraphs a previous
agent wrote into `build.mjs` as string constants and the generator printed
verbatim into the output.

That prose is **meaning inserted into generated output rather than recovered
from the C**, which is the one thing this leg's governing rule forbids. The
generated tree is the transpiler's output; the argument for a design decision
belongs where design decisions are argued.

| module | header lines before | after |
|---|---|---|
| `nhconst.js` | 8 | 3 |
| `nhmacro.js` | 10 | 3 |
| `nhfield.js` | 15 | 3 |
| `nhprop.js` | 14 | 3 |
| `nhmacrofn.js` | 19 | 3 |
| `nhrng.js` (this leg's, same rule) | 11 | 3 |

**74 lines of commentary removed.** What is kept is the factual stamp every
generated file already has and that the owner explicitly chose to keep —
`// Generated by tools/c2js — do not edit by hand`, the `Input:` path, the
`Input sha256:` and the `Transpiler:` line — plus one pointer line so a reader
of the module can find the explanation:

```js
// Generated by tools/c2js — do not edit by hand
// Transpiler: tools/c2js c2js emit v1+batch
// See docs/NOTES-readability.md §2 (field offsets) and §12 (element sizes).
```

Nothing was deleted as knowledge. Every claim the headers made is in `docs/`:

| claim | where it lives |
|---|---|
| enum constants merged across every TU; why a namespace and why `NHC` | `NOTES-named-constants.md` §The module, §Why a namespace import |
| `#define`s whose body is one integer token, named at their spelling location; why a second module and a second prefix | `NOTES-named-constants.md` (macro tier) §Tier 2, §Why a second module |
| field offsets named `<record>_<field>`; **the layout is the emitter's own, not the host C ABI's, and only has to be self-consistent inside the port**; why this makes a 5.1 struct change a readable diff | §2 above (the ABI sentence was added there with this change) |
| `sizeof_<record>` and `sizeof_<record>_x<count>` | §12 above |
| macro-body helpers, and the character-for-character audit that makes them shorthand rather than reinterpretation | §3 above |
| function-like macros: the back-substitution audit, the purity evidence, and the repeat-only admission rule | `NOTES-emit-hygiene.md` §3 |
| the rng-log helpers and the scored log | §13 above |

---

## 15. Perf: the interleaved A/B, and the size it is paid in

Three trees, interleaved, three rounds over all 69 sessions, both
`js/generated` and `js/generated-y` swapped every time, round direction
alternating. The middle tree is the shipping one with **only** `C2JS_RNGFOLD=0`,
because §13 is the only one of the seven that can plausibly move a cycle —
§9–§12 and §14 are comments and identifiers.

| tree | slope med (min) | fit intercept med | corpus engine med | 207-move session |
|---|---|---|---|---|
| (i) `main` `0e5980d` | 0.5565 (0.5395) | 864.6 ms | 95,112 ms | 980 ms |
| (ii) shipping, `C2JS_RNGFOLD=0` | 0.5477 (0.5413) | 767.0 ms | 86,823 ms | 880 ms |
| (iii) **shipping** | **0.5366 (0.5303)** | 754.0 ms | **85,233 ms** | **865 ms** |

Paired per-round against (i), which is the statistic that survives a drifting
box:

```
(ii)  slope  +0.3  -1.6  -1.3    median -1.3%
(iii) slope  -0.5  -4.7  -2.3    median -2.3%
```

**Round 3 is contaminated** — every tree measured ~18% slower in it than in
round 1 — which is exactly why both statistics are reported and why the paired
delta is the one quoted. All 27 runs passed 69/69.

### startup, measured directly rather than fitted

The corpus fit's intercept is an OLS extrapolation over 69 sessions and moves
with the machine (it reads 746.8 and 864.6 ms for the *same* tree an hour
apart). Since this leg adds 18% to the bytes the engine parses, startup is the
number most at risk and deserves a measurement of its own: the shortest session
(22 moves, where engine time is nearly all module load and init), **min and
median of 7 interleaved runs per tree**.

| tree | engine ms, min / median | vs main |
|---|---|---|
| (i) `main` | 721.9 / 734.7 | — |
| (ii) shipping, `C2JS_RNGFOLD=0` | 735.9 / 759.1 | **+1.9% / +3.3%** |
| (iii) **shipping** | **691.4 / 703.9** | **−4.2% / −4.2%** |

That is the whole story of this leg's cost, and it is coherent with the slope
table:

* **the comments, the names, the sizes and the JSDoc cost +1.9% of startup**
  and nothing measurable per move. They are 2.8 MB more source to parse and
  not one more instruction to run.
* **the rng-log fold pays for all of it and more: −6% of startup on its own**
  ((ii) → (iii)), and it is at or slightly below `main` on slope. Folding 2,679
  eleven-token ternaries out of the hottest functions in the program removes
  ~160 KB of bytecode from exactly the functions V8 has the most trouble
  optimizing, and a smaller hot function is a cheaper one to parse, to compile
  and to inline into.

The brief's guard for §13 was ~1% of slope, with an emit-time fast path as the
fallback if it cost more. It does not cost; it pays.

### size

| | `main` | this leg | Δ |
|---|---|---|---|
| `js/generated` | 15,639,713 | 18,474,574 | **+18.1%** |
| `js/generated-y` | 31,238,600 | 36,593,306 | +17.1% |
| `js/generated-y/__bundle.js` | 15,217,252 | 17,736,777 | +16.6% |

Roughly 2.8 MB, of which the C's comments and blank lines are about 2.1 MB and
the longer string-literal and size names most of the rest; the rng-log fold
gives ~160 KB back. It is the same trade leg 1 made (+19.5% there) and, unlike
leg 1's, it does **not** cost startup — §13 more than covers it.

---

## 16. Gates

Run on the final tree (`C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs
--all --force`).

| gate | result |
|---|---|
| batch build | 172 files: 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; **0 parse failures** |
| full rebuild reproduces the committed trees | **byte-identical** — `git status` clean after `--force` |
| all six flags off reproduces `main` | **byte-identical** for 164 of 172 modules. The 8 that differ are the five sidecar headers (§14 is not flag-gated: it is a policy, not a tier), `nhrng.js` (new, and with the fold off it comes out with no helpers), and the two gate fixtures `test-setjmp`/`test-union` regenerate |
| `C2JS_FOLD_VERIFY=1` | **323,336 folds, 0 mismatched, 0 unevaluable** |
| no-absolute-path assertion | **362 emitted modules, 0 hits** |
| `assertNamespaceExports()` | every `NHC.`/`NHM.`/`FLD.` name a module reads is exported |
| `assertPreloadPaths()` | all 4 exist |
| `reset-census` | 180 modules, 47,086 declarations, plan **1,416**, **0 unclassified** |
| corpus (`sessions/` + `sessions-extra/`), reset scoring path, Lua ports live, **twice** | **69/69** and **69/69** |
| yield + bundle corpus (`yieldtest/ps_test_runner.mjs`) | **69/69** |
| ...and 27 more full-corpus runs inside the A/B | **69/69 every time** |
| `reset-diff --via runsegment` | **12/12** pairs byte-identical to a fresh realm (17 forked reference graphs) |
| `tools/c2js/test-rnd.mjs` | PASS (3,130/3,130 and 2,983/2,983 RNG calls) |
| `tools/c2js/test-hacklib.mjs` | PASS — 870 cases, 0 failures |
| `tools/c2js/test-setjmp.mjs`, `test-union.mjs` | PASS (traces identical, output identical) |
| `node --test test/*.test.mjs` | **6/6** |
| `tools/c2js/purity-audit.mjs` | 15 functions `nhmacrofn.js` calls, **0 disagree** |
| `tools/strict-score.mjs` | 345 files reachable from 2 roots, **0 violations**; sandbox parity OK on 3 sessions |
| `judge-sim/run.mjs` seed8000 | **PASS**, 0 segment mismatches, 0 out-of-scope |
| `judge-sim/run.mjs` seed0013 | **PASS**, 2/2 segments, 0 out-of-scope |
| `judge-sim/playability.mjs --their-page --seed=1` | 130 moves, 353 requests, 0 out-of-scope, 0 404s, **0 console entries**, first frame 534 ms |
| carried-comment audit (§9) | 28,249 lines: **0** not verbatim in the C, **0** over-carried, **0** from outside the declaration's C region |

### counts, per task

| task | named / carried | left alone, and why |
|---|---|---|
| §9 comments | 15,535 comments (6,554 trailing), 20,516 blank lines | 1,671 lines a spliced copy declined; 365 comments share a line with code; 0 backslash-continued |
| §10 string names | 23,585 literals | 503 needed a `__2` collision suffix |
| §11 pointer JSDoc | 8,496 pointers | 142 bare (fn pointer, anon record, decayed array, >40 chars) |
| §12 element sizes | 21,377 sizes + 1,912 composed strides, 2,945 exported names | 9,226 machine widths by design; 23 refused by the equality audit; 381 `[21]` pointer-row strides |
| §13 rng-log fold | 2,679 of 2,724 draws, 6 helpers | 45 refused on an argument that writes or draws |
| §14 sidecar headers | 74 prose lines removed from 6 modules | the provenance stamp kept, by the owner's instruction |

---

## 17. Commits

* `3ee2cc4` — a pointer parameter has a type, and the AST always knew it (§11).
* `dbdd6ac` — name a literal after what it says, not when it was interned (§10).
* `3e169fe` — a stride is a `sizeof`, and the layout already knew which one (§12).
* `68a0fd5` — the rng-log instrumentation, once, instead of at 2,679 call sites (§13).
* `1529ad5` — the C author's running commentary, and their paragraphs (§9).
* `3e423e7` — provenance in the generated tree, argument in the docs (§14).
* two follow-ups regenerating the `setjmp`/`union` gate fixtures, which live
  outside `build.mjs --all`'s graph.

On `readable-2`, off `main` at `0e5980d`. Nothing pushed, nothing merged.
`js/generated` must be committed from a **normal** build, never a
`C2JS_FOLD_VERIFY=1` one.

## 18. Merge readiness

**Ready.** All seven ship on.

Every tier is emitter-side and flag-gated, every one is audited against
something decisive rather than plausible — the C source text for the comments,
string equality for the two arms of an rng-log ternary, `base × ∏counts` for a
composed stride, the corpus for all of them — and with the six flags off the
build reproduces `main` byte-for-byte apart from §14's policy change and the
new empty module.

The price is **+18.1% of source bytes**, and unlike leg 1 it is not paid in
time: startup is **−4.2%** and slope is at or slightly below `main`, because
§13 buys back more than §9–§12 spend.

What this leg deliberately did **not** do, in each case because doing it would
have meant inventing rather than recovering: name the `21` in a `ROWNO` stride
(the preprocessor consumed the name; 21 is the value of many macros), name a
machine width (`sizeof_int` is not NetHack's fact to move), fold an rng-log
site whose argument draws (it would rewrite the scored log), or carry a comment
into a spliced region twice (the C said it once).

---
---

# Readability, leg 3 — the shape tier (roadmap 1.14)

Branch `readable-3`, off `main` at `1fab203`. Two changes, and they pull in
opposite directions on bytes, which is the honest summary of the leg: one
deletes an annotation nothing reads, the other spends bytes on whitespace so
that a 5,090-character line becomes a shape.

| flag | default | what the other setting does |
|---|---|---|
| `C2JS_RNGCALLER=1` | **off** | restores the `rn2_at(file, line, func, x)` annotation at every folded draw (§19) |
| `C2JS_FMT=0` | on | restores one statement per line, however long (§20) |
| `C2JS_FMT_COLS=<n>` | 100 | moves the column budget |

With `C2JS_FMT=0 C2JS_RNGCALLER=1` the build reproduces `main` byte-for-byte
apart from one comment line in `nhrng.js` (§21).

---

## 19. The caller annotation is a debugging aid, and the scorer says so

§13 folded the recorder's rng-log ternary into one helper per PRNG entry point.
It kept the annotation, because the annotation is what the log prints:

```js
rn2_at(__s_detect_c, 146, __s_trapped_chest_at, 20)
```

The shipped tree now writes what the C wrote:

```js
rn2(20)
```

### why this cannot move the score, read off the scorer

`frozen/ps_test_runner.mjs` is the judge's harness and this is its whole
normalization:

```js
function normalizeRng(entry) {
    return entry.replace(/\s*@\s.*$/, '').replace(/^\d+\s+/, '').trim();
}
```

The `@ caller(file:line)` suffix and the call number are **discarded before the
C's entry and ours are compared**. What survives the normalization is the draw
text — `rn2(20)=0` — and, separately, the number of entries, which is compared
by index over the two arrays.

Neither depends on the caller, and the reason is in `rnd.c` rather than in the
harness: the entry is written by `rng_log_write()` **inside `rn2`**, and
`rng_log_set_caller()` only stores three variables that decide which of that
function's `fprintf` arms runs. With the caller never set, `rng_caller_file`
stays null and every entry takes the plain arm — same count, same text, no
suffix. Nothing else in the program reads those three variables; `rnd.js`'s
own `__captureState` carries them, and carrying three nulls is what it now does.

Measured rather than argued: the same session, built both ways.

| | entries | annotated | after `normalizeRng` |
|---|---|---|---|
| `C2JS_RNGCALLER=1` | 3,130 | 3,130 | — |
| shipped | 3,130 | 2,792 | **identical, byte for byte** |

The 2,792 is the one wrinkle and it is worth stating rather than hiding.
**The 45 sites §13 refused to fold are untouched**, as they should be — their
argument itself draws or writes, and that refusal is about evaluation order,
not about the annotation. They still call `rng_log_set_caller`, and the
recorder never clears the caller (deliberately: a wrapper's internal draws
inherit their caller), so after the first of those 45 fires every subsequent
entry prints a *stale* annotation. The scorer strips it; a human reading a
shipped-tree log should not trust it, and should build with
`C2JS_RNGCALLER=1`, which is exactly what the flag is for. Folding those 45
as well is available and would be provably output-equivalent once the caller
is gone — with nothing between the argument and the draw, the emitted
expression *is* the ternary's cold arm, character for character — but it is a
change to 45 shipped sites that this leg was not asked to make.

### the flag must keep working, and does

`C2JS_RNGCALLER=1` is not a courtesy. Localizing a divergence against the C
recorder means reading two logs side by side and finding the first entry whose
*caller* differs, which is how the whole Phase 1 grind was run and how a
Phase 2 merge against 5.1 will have to be run again. So the annotated build is
a gate, not a nicety: it is verified to produce the annotated log (3,130
entries, every one annotated) and to reproduce `main`'s trees byte-for-byte.

Both modes share the recognition, the two audits and the arity table of §13.
The only difference is at the end: with the flag on, the `rng_log_set_caller`
arguments are emitted and the site spells `rn2_at(...)`; with it off, they are
**not emitted at all** — which is the second half of the change.

### 806 string literals that named nothing else

`__FILE__` and `__func__` are string literals, and an emission interns them.
Not emitting them removes them from the module's string table wherever nothing
else in the module mentions them:

**24,129 → 23,323 interned literals, 806 dropped, 0 added.**

Most are `__func__` names (`__s_zap_over_floor`, `__s_x_monnam`) and a few are
`__FILE__` names for files whose only `__FILE__` use was the rng-log
(`__s_worm_c`, `__s_worn_c`). The `__FILE__` literal survives in every module
that also panics or allocates, because `nhalloc` and `panic` take it too —
which is the check that this dropped what it should and nothing more.

`nhrng.js` itself comes out as a header and nothing else: with no site
spelling a helper, an `import ... from './rnd.js'` there would be a module edge
the shipped graph does not need.

**js/generated 18,474,574 → 18,325,940 bytes (−0.80%)** on this change alone.

---

## 20. A shape for the expressions — `tools/c2js/jsfmt.mjs`

708 lines in `js/generated` were over 400 characters; the longest was 5,090.
Every tier so far gave the code back a *vocabulary* — enum names, field names,
element sizes, string names, the C author's own commentary. None of them gave
it back a *shape*, and a 5,090-character line does not have one.

### the model is dart_style, and its rules are the whole design

Dart's formatter is the right thing to copy: it solves this exact problem —
deeply nested expression code, machine-generated as often as not — and its
rules state in a paragraph.

1. A construct goes on one line if it fits the column budget.
2. When it does not, it splits at the **outermost** boundary first.
   "Outermost" is operator precedence read backwards: the lowest-precedence
   operator at the top level of the span is the one binding the construct most
   loosely, so breaking there separates the largest ideas. Statement separators
   first, then `,`, then assignment, then `?:`, then `||`, `&&`, `|`, `^`, `&`,
   equality, relational, shift, additive, multiplicative — and only then, when
   nothing at the top level splits, inside the widest bracketed group.
3. Once an argument list splits, **every** argument goes on its own line. A
   half-split list reads worse than either whole one.
4. Continuations are indented consistently.

Dart's two placement conventions come with it, and they are not arbitrary:
**a binary operator ends the line it continues from**, so a line ending in
`||` is visibly unfinished; **`?` and `:` begin theirs**, which is what turns a
nested conditional into an indented decision tree instead of a staircase of
question marks.

### the column budget is 100

NetHack's own C is written to 80. The port cannot be: `cptr.ldI32o(mtmp,
$monst_female)` is the transpiled spelling of `mtmp->female`, and at 80 columns
a two-load comparison — the single most common shape in the tree — would split
in the middle of saying one thing. 100 keeps those on one line, still fits two
windows side by side on any screen this is read on, and is what
`C2JS_FMT_COLS` moves if that judgement is wrong.

Indentation: a continuation is **one level (4 spaces) deeper than the line it
continues**, except that a statement's first continuation is **two levels**, so
a wrapped `if` condition can never be mistaken for the `if`'s body — which
matters here because the emitter writes single-statement bodies without braces.

### where a break may go, and why none of them can change the program

A break is only ever inserted

* after a binary operator, a `,`, a statement `;`, or an opening bracket;
* before `?`, before `:`, or before a closing bracket;

and never immediately after `return`/`throw`, nor before a postfix `++`/`--`.

That last clause is the automatic-semicolon-insertion argument in full. ASI
inserts a `;` only before a token the grammar cannot accept in that position;
a line ending in an operator, a comma or an open bracket cannot be terminated,
and a line beginning with `?`, `:` or a closing bracket cannot start a
statement. The two *restricted productions* JavaScript actually has —
`return [no LineTerminator here] Expression` and
`LeftHandSideExpression [no LineTerminator here] ++` — are excluded by
construction, because `return` is never the last token of a line the formatter
writes and a postfix `++` is never the first.

### the audit is token identity

The argument above is a proof about the rules. The **audit** is a fact about
each line, and it is what actually ships: every reformatted line is
re-tokenized and its token sequence compared, kind and text, against the
original's. The formatter only ever writes back exact source slices with
whitespace between them, so a mismatch is impossible in theory; a line that
fails is emitted unchanged and counted, and the count is printed by the build.

**19,592 lines wrapped, 0 failed the audit.** Every file still passes
`node --check`, which the batch build runs per module.

### what is filled rather than split

Rule 3 — one item per line — earns its keep on an *argument* list, where each
item is an expression the reader takes in on its own. It is wrong for a list of
150 bare identifiers, which is a paragraph. Three of those exist and all three
are filled to the budget instead: the cross-module `import { ... }` lists, the
field-offset preamble (which has filled its names since §2, for this reason),
and `resetify`'s `__captureState` array — `decl.js`'s was 2.5 KB on one line.

### comments

The C author's comments are **never** reflowed. Their layout is theirs — §9's
`do_entity` staircase is the case that proves it — and a whole-line comment is
passed through byte-for-byte. A **trailing** comment is detached, its statement
is wrapped, and the comment is re-attached to the last line the statement
produced, which is the same rule §9 used to place it; 450 of the 6,554 trailing
comments landed on a wrapped statement. A statement is never split merely to
make room for its trailing comment: the budget is measured on the code.

Our own `/** C ref: ... */` markers are a different matter — they are the
emitter's, not the C's, and the JSDoc tiers have grown them to 237 characters
of `@param`. **1,821 of them are reflowed** into ordinary JSDoc blocks, one tag
per line, audited by word-for-word comparison of the content.

### what stays long

**1,046 lines are over budget with no break point**, and they divide into two
honest classes: a `const __s_... = cptr.lit("...")` whose string literal is
itself longer than the budget, and a statement whose *code* fits but whose
trailing comment does not. Neither is splittable without lying about the
source.

### the numbers

| | `main` | §19 | **shipped** |
|---|---|---|---|
| lines in `js/generated` | 357,529 | 356,650 | 490,060 |
| over 100 chars | 26,936 | 26,264 | **2,743** |
| over 200 chars | 4,119 | 4,020 | **5** |
| over 400 chars | 734 | 713 | **1** |
| longest line | 5,090 | 5,090 | **544** |

All five lines still over 200 characters are in `js/generated/isaac64.js`, and
they are there because that file is **never re-emitted**: it is the one
translation unit the emitter fails on (`169 ok, 1 failed` in every batch build,
expected since 1.0), so `assemble()` — and therefore the formatter — never sees
it. It is also not in the module graph: the transpiled `rnd.js` imports the
hand-written `js/isaac64.js` instead, and this file does not even parse. Every
line over 200 characters in the shipped tree is in a module nothing loads.

### the Phase 2 argument, which is why this is worth bytes

A 5,090-character line is one diff hunk. Change one field offset inside it and
the whole line is rewritten: 5,090 characters of churn for a four-character
change. Wrapped, the same edit touches one 60-character line and the other 45
lines of that statement are context.

Phase 2 scores a 5.1 merge by the complexity of the diff it takes. Every line
this splits is a line that can be *diffed* against 5.1 rather than re-read, and
the effect compounds: the emitter is deterministic, so two builds of two
adjacent NetHack versions produce wrapped trees whose unchanged statements are
unchanged lines. That is the return on the bytes below.

### the acceptance demo

`detect.js`'s `trapped_door_at`, before (`main`) and after — both changes
visible in it, since its draw is one of the 2,679:

```js
export function trapped_door_at(ttyp, x, y) {
    let lev;

    if (!glyph_is_trap(glyph_at(x, y)))
        return 0;
    if (ttyp != NHC.TRAPPED_DOOR || (Hallucination() && rn2_at(__s_detect_c, 188, __s_trapped_door_at, 20)))
        return 0;
    lev = cptr.add(cptr.add(cptr.add(svl, $instance_globals_saved_l_level), x, $sizeof_rm_x21), y, $sizeof_rm);
    if (!((cptr.ld1so(lev, $rm_typ)) == NHC.DOOR))
        return 0;
    if ((((cptr.ldI32o(lev, $rm_flags) & 31) | 0) & 3) != 0 && trapped_chest_at(ttyp, x, y))
        return 0;
    return 1;
}
```

```js
export function trapped_door_at(ttyp, x, y) {
    let lev;

    if (!glyph_is_trap(glyph_at(x, y)))
        return 0;
    if (ttyp != NHC.TRAPPED_DOOR || (Hallucination() && rn2(20)))
        return 0;
    lev = cptr.add(
        cptr.add(cptr.add(svl, $instance_globals_saved_l_level), x, $sizeof_rm_x21),
        y,
        $sizeof_rm
    );
    if (!((cptr.ld1so(lev, $rm_typ)) == NHC.DOOR))
        return 0;
    if ((((cptr.ldI32o(lev, $rm_flags) & 31) | 0) & 3) != 0 && trapped_chest_at(ttyp, x, y))
        return 0;
    return 1;
}
```

and the genuinely bad case the brief named — the `flash_glyph_at` call in the
same file (`detect.c`'s secret-door flash), 1,131 characters on one line:

```js
        flash_glyph_at(zx, zy, (((sym) == NHC.S_stone) ? NHC.GLYPH_CMAP_STONE_OFF : (((sym) <= NHC.S_trwall) ? (((((sym) - NHC.S_vwall) | 0) + (In_mines(cptr.add(u, $you_uz)) ? NHC.GLYPH_CMAP_MINES_OFF : (In_hell(cptr.add(u, $you_uz)) ? NHC.GLYPH_CMAP_GEH_OFF : ((((cptr.ldI16o((cptr.add(svd, $instance_globals_saved_d_dungeon_topology + $dgn_topology_d_knox_level)), $d_level_dlevel) || cptr.ldI16((cptr.add(svd, ...
```

becomes the decision tree the C's nested `?:` always was:

```js
        flash_glyph_at(
            zx,
            zy,
            (((sym) == NHC.S_stone)
                ? NHC.GLYPH_CMAP_STONE_OFF
                : (((sym) <= NHC.S_trwall)
                    ? (((((sym) - NHC.S_vwall) | 0) +
                        (In_mines(cptr.add(u, $you_uz))
                            ? NHC.GLYPH_CMAP_MINES_OFF
                            : (In_hell(cptr.add(u, $you_uz))
                                ? NHC.GLYPH_CMAP_GEH_OFF
                                : ((((cptr.ldI16o(
                                    (cptr.add(
                                        svd,
                                        $instance_globals_saved_d_dungeon_topology +
                                            $dgn_topology_d_knox_level
                                    )),
                                    $d_level_dlevel
                                ) ||
                                    cptr.ldI16((cptr.add(
                                        svd,
                                        $instance_globals_saved_d_dungeon_topology +
                                            $dgn_topology_d_knox_level
                                    )))) &&
                                    on_level(
                                        cptr.add(u, $you_uz),
                                        cptr.add(
                                            svd,
                                            $instance_globals_saved_d_dungeon_topology +
                                                $dgn_topology_d_knox_level
                                        )
                                    )))
                                    ? NHC.GLYPH_CMAP_KNOX_OFF
                                    : ((cptr.ldI16((cptr.add(u, $you_uz))) == sokoban_dnum())
                                        ? NHC.GLYPH_CMAP_SOKO_OFF
                                        : NHC.GLYPH_CMAP_MAIN_OFF))))) | 0)
                    : (((sym) < NHC.S_altar)
                        ? (((((sym) - NHC.S_ndoor) | 0) + NHC.GLYPH_CMAP_A_OFF) | 0)
                        : (((sym) == NHC.S_altar)
                            ? ((NHC.GLYPH_ALTAR_OFF + NHC.altar_neutral) | 0)
                            : (((sym) < ((NHC.S_arrow_trap + ((NHC.TRAPNUM - 1) | 0)) | 0))
                                ? (((((sym) - NHC.S_grave) | 0) + NHC.GLYPH_CMAP_B_OFF) | 0)
                                : (((sym) <= NHC.S_goodpos)
                                    ? (((((sym) - NHC.S_digbeam) | 0) + NHC.GLYPH_CMAP_C_OFF) | 0)
                                    : NHC.MAX_GLYPH)))))),
            6
        );
```

The `| 0` that ends the fourth-from-last line is there because of one deliberate
exception to rule 2: **a split whose right operand is a single token of four
characters or less is not taken.** The emitter's int normalization writes
`(expr) | 0` and `(expr) >>> 0` around a very large number of expressions, and
`0` alone on a continuation line is the least informative line this formatter
could produce. Declining those candidates lets the operator *inside* the
parenthesis do the split, which is the one that separates ideas.

---

## 21. Perf: what the whitespace costs, measured twice

Three trees, interleaved, three rounds over all 69 sessions, both
`js/generated` and `js/generated-y` swapped every time, round direction
alternating (`main, §19, §19+§20` / reversed / forward).

* (i) `main` `1fab203`
* (ii) `7464b2e` — §19 only
* (iii) `bb25ff8` — **shipped**

**All 27 corpus runs passed 69/69.**

| tree | slope med (min) | fit intercept med | corpus engine med (min) |
|---|---|---|---|
| (i) `main` | 0.6425 (0.6332) | 919.6 ms | 102,643 (100,011) ms |
| (ii) §19 only | 0.6479 (0.6322) | 898.9 ms | 102,126 (99,971) ms |
| (iii) **shipped** | **0.6416 (0.6325)** | 888.5 ms | **101,839 (100,454) ms** |

Paired per round against (i), which is the statistic that survives a drifting
box:

```
        round 1   2      3     median
(ii)  slope  +2.9  +2.3  -1.6   +2.3%
(ii)  total  -2.2  -0.5  -0.0   -0.5%
(iii) slope +11.9  +1.3  -1.6   +1.3%
(iii) total  -0.2  -0.8  +0.4   -0.2%
```

**Round 1's `+11.9%` slope is not a per-move cost and should not be read as
one.** In the same run the fitted *intercept* came out 73 ms **lower** than
`main`'s and the total corpus engine time was −0.2%: the OLS fit over 69
sessions traded intercept against slope, and the total — which is a
measurement rather than a fit — did not move. The same tree measured 0.6416 and
0.6325 in the next two rounds. The load average on this box ran 7–14 through
the third round and the wall time per corpus run went from ~3 minutes to ~20;
that is the environment the previous two legs' notes describe, and it is why
this table quotes the paired per-round deltas and the total.

**Neither change is separable from the noise floor on slope, and total corpus
engine time is flat to within 1%.**

### startup, measured directly

The fit's intercept is an extrapolation and moves with the machine (873–920 ms
for `main` in three rounds an hour apart), so the number most at risk here —
11% more source for V8 to parse — gets its own measurement: the shortest
session (`seed8000`, 22 moves, where engine time is nearly all module-graph
instantiation and `newgame()`), **15 interleaved runs per tree**.

| tree | engine ms, min / median | vs `main` (min / median) | paired median |
|---|---|---|---|
| (i) `main` | 702.2 / 731.3 | — | — |
| (ii) §19 only | 699.9 / 731.7 | −0.3% / +0.1% | −0.5% |
| (iii) **shipped** | **699.7 / 736.4** | **−0.4% / +0.7%** | **+0.6%** |

**+11.7% of source bytes costs about half a percent of startup, and that half
percent is inside the run-to-run spread.** That is a specific fact about *what*
the bytes are: leg 2 paid +1.9% of startup for +18% of bytes when those bytes
were comments and longer identifiers; these bytes are newlines and leading
spaces, which V8's scanner skips without allocating a token, and which produce
not one extra byte of bytecode. §19's −0.8% of source and its 2,679 removed
call arguments do not show up either.

### size

| | `main` | §19 | shipped | Δ vs `main` |
|---|---|---|---|---|
| `js/generated` | 18,474,574 | 18,325,940 | 20,467,274 | **+10.8%** |
| `js/generated-y` | 36,593,306 | 36,297,414 | 40,542,565 | +10.8% |
| `js/generated-y/__bundle.js` | 17,736,777 | 17,589,519 | 19,693,394 | +11.0% |

§19 gives back 148,634 bytes; §20 spends 2.14 MB of them on whitespace.

**Is the combination net negative?** No, on the evidence above: it is neutral
on both statistics that were measured, at a price of 10.8% of bytes that is
paid in disk and not in time. The honest caveat is that the box was contended
enough that a real ±1% effect on slope would not have been visible; what the
data rules out is a large one, and round 1's `+11.9%` is the kind of artefact
that would have been reported as a regression if a single run had been quoted.

---

## 22. Gates

Run on the final tree (`C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs
--all --force`, then `test-union.mjs` / `test-setjmp.mjs` for the two fixtures
outside its graph).

| gate | result |
|---|---|
| batch build | 172 files: 169 transpiled, 1 failed (isaac64, expected), 2 prelude-proven; **0 parse failures** |
| full rebuild reproduces the committed trees | **byte-identical** — `git status` clean over `js/generated`, `js/generated-y`, both reset barrels, `__bundle.js` and `js/boot/harness-y.mjs` |
| `C2JS_FMT=0 C2JS_RNGCALLER=1` reproduces `main` | **byte-identical**, except one comment line in `nhrng.js` (which now points at §19) and its two copies |
| `C2JS_FMT=0` reproduces the §19 tree | **byte-identical** across the whole `--all` graph |
| `C2JS_RNGCALLER=1` writes the annotated log | 3,130 entries, **3,130 annotated**; identical to the shipped tree's log after `normalizeRng` |
| jsfmt token audit | 19,592 lines wrapped, **0 failed**; 1,821 C-ref markers reflowed, 450 trailing comments carried |
| `C2JS_FOLD_VERIFY=1` | **320,657 folds, 0 mismatched, 0 unevaluable** |
| no-absolute-path assertion | **362 emitted modules, 0 hits** |
| `assertNamespaceExports()` | every `NHC.`/`NHM.`/`FLD.` name a module reads is exported |
| `assertPreloadPaths()` | all 4 exist |
| `reset-census` | 180 modules, 46,280 declarations, plan **1,416**, **0 unclassified** |
| corpus (`sessions/` + `sessions-extra/`), reset scoring path, **twice** | **69/69** and **69/69** |
| yield + bundle corpus (`yieldtest/ps_test_runner.mjs`) | **69/69** |
| ...and 27 more full-corpus runs inside the A/B | **69/69 every time** |
| `reset-diff --via runsegment` | **12/12** pairs byte-identical to a fresh realm (17 forked reference graphs) |
| `tools/c2js/test-rnd.mjs` | PASS (3,130/3,130 and 2,983/2,983 RNG calls) |
| `tools/c2js/test-hacklib.mjs` | PASS — 870 cases, 0 failures |
| `tools/c2js/test-setjmp.mjs`, `test-union.mjs` | PASS (traces identical, output identical) |
| `node --test test/*.test.mjs` | **6/6** |
| `tools/c2js/purity-audit.mjs` | 15 functions `nhmacrofn.js` calls, **0 disagree** |
| `tools/strict-score.mjs` | 344 files reachable from 2 roots, **0 violations**; sandbox parity OK on 3 sessions |
| `judge-sim/run.mjs` seed8000 | **PASS**, 0 segment mismatches, 0 out-of-scope |
| `judge-sim/run.mjs` seed0013 | **PASS**, 2/2 segments, 0 out-of-scope |
| `judge-sim/playability.mjs --their-page --seed=1` | 130 moves, 352 requests, 0 out-of-scope, 0 404s, **0 console entries**, first frame 615 ms |

### counts, per task

| task | done | left alone, and why |
|---|---|---|
| §19 caller annotation | 2,679 draws emit the bare call; 806 string literals dropped, 0 added | the 45 sites §13 refused (argument draws or writes) keep the inline ternary and their annotation |
| §20 line splitting | 19,592 statement lines → 138,043; 1,821 C-ref markers reflowed | 1,046 lines over budget with no break point (a string literal longer than the budget, or a statement whose code fits and whose trailing comment does not); the C author's own comments are never reflowed |

---

## 23. Commits

* `7464b2e` — the caller annotation is a debugging aid, not a scored one (§19).
* `bc648c0` — a Dart-style line splitter for the emitted expressions (§20).
* `bb25ff8` — the union gate fixture, regenerated with this emitter (it lives
  outside `build.mjs --all`'s graph; `setjmp_gate.js` has no line over the
  budget and is unchanged).

On `readable-3`, off `main` at `1fab203`. Nothing pushed, nothing merged.
`js/generated` must be committed from a **normal** build, never a
`C2JS_FOLD_VERIFY=1` one.

## 24. Merge readiness

**Ready.** Both ship in their default positions.

§19 is a deletion justified by reading the scorer: the annotation is stripped
before comparison, the entry count does not depend on it, and the two logs are
byte-identical after `normalizeRng`. The capability it removes from the shipped
tree is restored in full by `C2JS_RNGCALLER=1`, which is verified rather than
assumed, because Phase 2 will need it.

§20 is the first tier in three legs that changes the *shape* of the output
rather than its vocabulary, and it is the one with the strongest audit: every
wrapped line is compared token for token against the line it replaced, and
0 of 19,592 disagreed. It costs 10.8% of source bytes and, measured directly,
about half a percent of startup — inside the noise. What it buys is that the
longest line in the shipped tree is 544 characters instead of 5,090, that only
five lines exceed 200 and all five are in a module nothing loads, and that a
Phase 2 diff against 5.1 lands on lines rather than on ribbons.

What this leg deliberately did **not** do: fold the 45 rng-log sites whose
argument draws (provably safe once the caller is gone, but a change to shipped
sites the brief scoped out — §19 records the one visible consequence, a stale
`@` suffix in a shipped-tree debug log that the scorer discards); reflow the C
author's comments (their layout is theirs); or split a statement to make room
for its trailing comment.
