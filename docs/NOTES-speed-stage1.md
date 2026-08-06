# Speed stage 1 — fusing the address into the access

One change, in two places: `cptr.js` grows a fused offset accessor for every
load and store the emitter emits against a computed address, and `emit.mjs`
emits those instead of the `accessor(add(base, K))` pair. Nothing else moved.

Baseline: `cef20eb`. Corpus is byte-exact 69/69 before and after (run twice).

---

## Why this and not something else

The CPU profile of `sessions/seed4500-knight-coverage` says `js/cptr.js` is
38% of engine self time, and the largest single entry in it is `add` at 11.6% —
a four-line function whose entire job is to return `{buf, off}`. Another ~8%
is GC, most of it collecting those same objects.

`add` is not slow. It is called 173,677 times *in the source text*, and almost
every one of those calls exists only to hand an address to the very next call:

```js
cptr.ldI32(cptr.add(svl, 89132))
cptr.stPtr(cptr.add(cptr.add(mtmp, 312), 40), v)
```

V8 can delete the intermediate object — escape analysis does exactly this —
but only when the `add` *and* the accessor both inline into the caller. The
callers here are NetHack's generated functions, which are large enough that
the inliner runs out of budget long before it gets to the leaves. So the
allocation mostly survives, once per field access, for the whole run.

Fusing removes the object from the *source*, where no optimizer decision can
bring it back.

## What was added

`js/cptr.js`: one `Xo` for each accessor that actually appears fused in
`js/generated/**` (ranked by site count before choosing) — `ld1so`, `ld1uo`,
`st1o`, `ldI16o`, `ldU16o`, `stI16o`, `ldI32o`, `stI32o`, `ldI64o`, `ldU64o`,
`stI64o`, `stU64o`, `ldPtro`, `stPtro`, `ldF64o`, `stF64o`. Sixteen, which is
all of them.

The contract each one keeps, and the reason it is safe:

```
ldXo(p, n, sz)     ===  ldX(add(p, n, sz))
stXo(p, n, v, sz)  ===  stX(add(p, n, sz), v)
```

for *every* input, not just the ones C generates. The fast path is entered only
for a buffer-backed CPtr with a numeric index; its offset arithmetic is copied
from `add` verbatim and its access from the accessor's non-box body. Everything
else — boxes, `boxProp`, function designators, the integer-bit-pattern pointers
`ldPtr` hands back for NetHack's `anything` union, BigInt indices, plain-Array
storage, subarray views whose 64-bit read runs off the end — falls through to
the literal composition. Those cases cannot diverge even in principle, because
on that path the new code *is* the old code. That includes the cases where the
composition throws: `add` drops `isBox`, so a box at a non-zero offset is a
TypeError before and after.

`tools/c2js/emit.mjs`: `fuseOffsetAccess`, applied at the single choke point
`cptrCall`, right after the existing constant-address-chain merge. It rewrites
`cptr.ldX(cptr.add(A, B[, S]))` → `cptr.ldXo(A, B[, S])` and
`cptr.stX(cptr.add(A, B[, S]), V)` → `cptr.stXo(A, B, V[, S])`, reusing
`splitTopLevelArgs` (which returns null unless the trailing `)` is the one that
closes the call, so a code string like `cptr.add(a, b) + x` is rejected rather
than mangled). Non-constant and scaled indices fuse too — `cptr.ldPtro(objects,
otyp, 96)` — which is where the array subscripts live.

Everything routes through `cptrCall`, so compound assignment (`x->f += 1`, which
emits the address twice) and read-modify-write fuse without a special case.

## Numbers

Fusion is a source-level change, so start with the source:

| | cef20eb | fused | |
|---|---|---|---|
| `cptr.add(` call sites in `js/generated` | 173,677 | 32,438 | −81% |
| fused `cptr.<X>o(` call sites | 0 | 141,239 | |
| `js/generated/**` source bytes | 14,721,427 | 13,450,276 | −8.6% |

### Speed fit — `node frozen/ps_test_runner.mjs sessions/`

Seven interleaved A/B pairs (alternate runs, same shell, same machine state).
The OLS fit over 44 heterogeneous sessions is noisy (R² ≈ 0.72), so the
medians are the honest reading and the spread is quoted with them:

| | startup_ms | per_move_ms |
|---|---|---|
| cef20eb | median **768** (739 – 974) | median **3.37** (3.21 – 3.70) |
| fused | median **683** (661 – 716) | median **2.95** (2.78 – 3.25) |
| | **−11%** | **−12.5%** |

The startup distributions do not overlap at all (base min 739 > new max 716);
the slope distributions overlap in exactly one sample.

Because the fit is noisy, here is the same data as a paired measurement —
best-of-3 wall time per session, summed over all 44 sessions (11,349 moves):

**69,558 ms → 62,078 ms, −10.8%.** Every heavy session improved:

```
0.749  seed0002-healer-reflection-drummer     2032 -> 1521 ms
0.847  seed4500-knight-coverage               3641 -> 3083 ms
0.868  seed0014-dequa-fountain-explore        2538 -> 2202 ms
0.891  seed0373-barbarian-quest-tour          1880 -> 1675 ms
0.901  seed0360-wizard-world-tour             3876 -> 3492 ms
0.909  seed0367-priest-quest-tour             3163 -> 2874 ms
0.914  seed0361-archeologist-tour             2810 -> 2570 ms
0.925  seed0030-ten-diverse-deaths           10165 -> 9405 ms
```

The startup win is not a separate trick: 1.27 MB less generated JavaScript is
1.27 MB less for V8 to parse and compile before the first move, which is why
`compileSourceTextModule` drops from 7.2% to 5.8% of the profile below.

### Playability — `frozen/playability_runner.mjs sessions/seed4500-…`

Five interleaved runs each: cef20eb 2.12 / 2.21 / 2.23 / 2.24 / 2.29 ms/move;
fused 1.71 / 1.71 / 1.83 / 1.84 / 1.86. **Best 2.12 → 1.71, −19%.** Still above
the runner's 1 ms/move threshold, which the browser path clears by other means
(docs/NOTES-transport-ladder.md).

### CPU profile — `seed4500`, engine child process

`NODE_OPTIONS="--cpu-prof"` so the profile follows the child the runner spawns.

| | cef20eb | fused |
|---|---|---|
| total | 4,984 ms | 3,966 ms |
| `js/cptr.js` self time | 1,905 ms (38.2%) | 1,429 ms (36.0%) |
| `add` | **11.58%** | **4.32%** |
| GC | 8.2% | 7.9% |
| `compileSourceTextModule` | 7.23% | 5.80% |

`add`'s absolute self time falls by three quarters. cptr's *share* barely moves
(38.2% → 36.0%) because the work it used to spend in `add` did not vanish into
another module — it vanished. The whole profile got 20% smaller underneath it.
The remaining `add` calls are the ones with nothing to fuse into: pointer
arithmetic whose result is a value (`p + 1` assigned to a variable, arguments to
`strcpy`/`memcpy`, `postinc` closures).

## DataView: measured, and dropped

Byte assembly vs a cached `DataView` for the multi-byte accessors. The cache has
to be nearly free or the win evaporates, so three cache strategies were measured
against the byte path (ratio < 1 means DataView is faster):

| accessor | DataView on the byte buffer | on the ArrayBuffer | WeakMap by ArrayBuffer |
|---|---|---|---|
| `ldU64` (getBigUint64) | **0.46x** | 0.64x | 0.90x |
| `ldPtr` halves (2 × getUint32) | 0.83x | | 2.44x |
| `ldI32` | 0.95x | | 2.65x |
| `ldI16` | | | 3.25x |
| `stI32` | | | 2.64x |
| `stU64` (setBigUint64) | | | 6.64x |

Two clear reads: stores must stay byte assembly (`setBigUint64` forces the
BigInt that `stU64`'s integer fast path exists to avoid — 6.6x worse), and the
one real prize is `getBigUint64`, which builds the same BigInt 2.2x faster than
the two-halves assembly *if* the view is cached on the byte buffer itself.

So the promising half was implemented for real — a lazily attached
non-enumerable `__cptrDV` on each byte buffer, used by `ldU64`/`ldU64o` (and
therefore `ldI64o`) and `ldPtr`/`ldPtro`, values and signedness untouched,
guarded by `(o >>> 0) === o` so negative/fractional offsets keep the byte path
and the OOB throw still fires against the *view* length — and measured on the
corpus, not the microbench. Six interleaved runs of the 20,119-move omnibus:

```
fusion only  24,749  25,036  24,930  26,236  26,491  28,027   min 24,749  median 25,633
+ DataView   25,522  25,689  25,858  27,685  27,805  30,988   min 25,522  median 26,772
```

**DataView loses by 3–4% on the real corpus and is dropped.** The microbench
measured 40 long-lived buffers; the port has thousands, in several shapes
(whole buffers, subarray rows, plain-Array storage), so the `__cptrDV` property
load that was monomorphic in the bench is not monomorphic in the engine, and
the extra branch sits in the hottest functions there are. Kept the fusion, kept
the byte assembly. The 64-bit two-halves representation is untouched.

## `postinc` / `postdec`: looked at, not taken

`postinc` is 0.84% of the profile and there are 380 sites, but they are pointer
*variable* increments driven through two closures (`cptr.postinc(() => p, (v) =>
{ p = v; })`), not address computations — there is no offset to fuse. Removing
the closures means emitting a comma expression with a temporary, which is an
emitter change with real risk and ~1% of upside. Left alone. The 50 sites of
`postinc1(cptr.add(...))` (a `char` location) are too few to be worth a
seventeenth accessor.

## Verification

1. **Differential fuzzer**, old `cptr.js` vs new, in lockstep across two
   parallel universes (own buffers, own pointer pool), comparing the returned
   value, the thrown message, and the full contents of every buffer after each
   op. 830,000 fused cases and 120,000 plain-accessor cases over five seeds,
   every accessor covered, exotic operands included (box, boxProp, function
   designator, int-bit-pattern pointer, plain-Array storage, subarray view,
   at-end and negative offsets, BigInt/string/NaN indices, scale factors
   including 0 and −1). **0 mismatches.** The DataView variant was fuzzed the
   same way and the negative/fractional-offset divergence it introduced is what
   the `(o >>> 0) === o` guard came from — the fuzzer found it, not the corpus.
2. **Build**: 172 files, 169 ok / 1 failed / 2 skipped — identical to cef20eb.
   `C2JS_FOLD_VERIFY=1`: 301,692 folds, 0 mismatched, 0 unevaluable. Consecutive
   `--all --force` builds are byte-identical, and cef20eb's tree reproduces
   exactly from cef20eb's emitter.
3. **Suites**: test-rnd, test-hacklib, test-setjmp, test-union, `node --test`
   (8/8), posix-ere (23,996 differential cases).
4. **Corpus**: `sessions/ sessions-extra/` **69/69 byte-exact, twice.**
5. **Browser**: `tools/judge-sim/run.mjs seed8000-tourist-starter` PASS, 0
   segment mismatches, 0 out-of-scope requests; `judge-sim/playability.mjs
   --keys=hjklhjklhjkl` engages the `xhr` transport, `"console_entries": []`.

### One thing to know about `C2JS_FOLD_VERIFY=1`

It re-runs each `expr_*` emitter to audit a fold, and those calls record symbol
references as a side effect, so a FOLD_VERIFY build emits a few extra *unused*
imports (12 files, import lines only). This predates stage 1 and is cosmetic,
but it means a FOLD_VERIFY build's output should not be committed. Commit from
a plain `--all --force` build; that one is byte-reproducible.

## Stage 2 candidates, with the measurement that justifies each

1. **Fuse the scaled index and the constant together.** 6,647 sites still read
   `cptr.ldI64o(cptr.add(cptr.add(u, 112), NHC.FAST, 24), 16)` — an array
   subscript *and* a field offset, so one `add` survives. These are
   `u.uprops[…]`, i.e. every intrinsic test NetHack makes. A four-argument form
   would take them, but the index would have to be proven numeric (an emitted
   `n * 24` on a BigInt throws where `add`'s `Number(n) * 24` does not), so it
   needs the emitter's type information, not a string rewrite. Highest
   confidence of the three.
2. **Direct aligned typed-array views for the big arenas.** The remaining
   accessor cost is byte assembly: `ldI32o` 2.13%, `st1o` 3.46%, `stU64o`
   1.91%, `ldPtro` 3.66%. A struct field at a fixed offset in an 8-aligned
   arena could read through a cached `Int32Array` at `off >> 2`. The DataView
   result above is the warning: the win must survive thousands of buffers and
   several storage shapes, and it did not for DataView. Prototype on one arena
   (`svl`/`u`) and A/B before generalizing.
3. **Newgame / startup.** Startup is 683 ms against a 2.95 ms slope, so on a
   typical 200-move session it is 55% of the bill and the category rival's
   1,326 ms is where we already win. `compileSourceTextModule` is 5.8% of the
   profile and fell in proportion to generated bytes — further source shrink
   (2, above, and the remaining `cptr.add`) pays the intercept for free. Beyond
   that the startup cost is genuine engine work in `newgame`, which needs its
   own profile before anyone guesses at it.
