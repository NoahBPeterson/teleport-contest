# Speed stage 2 — fusing the scaled index and the constant offset

Stage 1 (docs/NOTES-speed-stage1.md) fused *one* address component into every
load and store. This fuses the rest: an array subscript **and** a field offset
in the same call. Same two files, same method, same referee.

Baseline: `ad0f89d` (stage 1 merged). Corpus is byte-exact 69/69 before and
after, run twice.

---

## The shape that was left

Stage 1 left 32,438 `cptr.add` sites, and a third of them were this:

```js
cptr.ldI64o(cptr.add(cptr.add(u, 112), NHC.FAST, 24), 16)
```

`u.uprops[FAST].intrinsic` — every intrinsic test NetHack makes. Two address
components (a scaled subscript and a constant field offset) means one `add`
still had to build a `{buf, off}` and hand it over.

The `o2` forms take the whole address. The `o3` forms take the
two-subscript shape (`levl[x][y].field`), for the eight accessors a
doubly-subscripted C array actually reaches.

## What was added

`js/cptr.js`: sixteen `o2` forms (one per accessor that fuses) and eight `o3`
forms. The contract, kept by construction exactly as stage 1's is:

```
ldXo2(p, i, sz, off)            === ldXo(add(p, i, sz), off)
stXo2(p, i, sz, off, v)         === stXo(add(p, i, sz), off, v)
ldXo3(p, i, sz, j, sz2, off)    === ldXo2(add(p, i, sz), j, sz2, off)
stXo3(p, i, sz, j, sz2, off, v) === stXo2(add(p, i, sz), j, sz2, off, v)
```

for *every* input, because on the slow path the body literally **is** that
composition. Boxes, function designators, the integer-bit-pattern pointers
`ldPtr` hands back for the `anything` union, plain-Array storage, out-of-range
offsets and the cases that throw all take that path, so they cannot diverge
even in principle.

The fast path's offset arithmetic is `add`'s, applied twice in `add`'s own
left-to-right order — `((p.off + i * sz) + j * sz2) + off`. Every term is an
integer far inside 2^53.

The stage-1 notes predicted the hard part correctly: *"the index would have to
be proven numeric (an emitted `n * 24` on a BigInt throws where `add`'s
`Number(n) * 24` does not), so it needs the emitter's type information."* It
does not. The `typeof i === 'number'` guard decides it at run time and hands
BigInt subscripts to the composition, where `add` coerces them exactly as it
always did. No emitter type information, no per-site proof, one guard.

`tools/c2js/emit.mjs`: `fuseOffsetAccess` grows a chain decomposer. An address
is taken apart into a base, its scaled terms **in source order**, and the sum
of its constant displacements, then re-emitted as the deepest fused form that
fits. Anything deeper than `o3` puts the leading subscripts back into an
explicit `cptr.add`, so the rewrite is total. Term order is what keeps
evaluation order identical; only integer literals fold into the constant, and
those have no side effects. `EMIT_VERSION` 7 → 8.

## Numbers

### Source

| | ad0f89d | stage 2 | |
|---|---|---|---|
| `cptr.add(` sites in `js/generated` | 32,438 | 10,372 | −68% |
| `cptr.<X>o(` | 141,239 | 127,367 | |
| `cptr.<X>o2(` | 0 | 11,679 | |
| `cptr.<X>o3(` | 0 | 2,193 | |
| `js/generated/**` bytes | 13,450,276 | 13,221,856 | −228 KB |

13,872 addresses that used to cost an allocation now do not. The 10,372
`cptr.add` sites that remain are the ones with nothing to fuse into: addresses
used as *values* (`p + 1` assigned, arguments to `memcpy`/`strcpy`), plus
isaac64.js, which is never regenerated.

### Speed fit — `node frozen/ps_test_runner.mjs sessions/`

Seven interleaved A/B pairs (alternate runs, same shell, same machine state),
44 sessions, 11,349 moves.

| | startup_ms | per_move_ms | wall total |
|---|---|---|---|
| ad0f89d | median **789.1** (774.9 – 818.7) | median **3.272** (3.181 – 3.846) | median 71,314 ms |
| stage 2 | median **767.4** (756.4 – 788.7) | median **3.103** (3.000 – 3.759) | median 68,785 ms |
| | **−2.7%** | **−5.2%** | **−3.5%** |

Pair 1 is the cold first run on both sides and is the whole of the overlap:
drop it and the slope distributions are disjoint (base 3.205 – 3.846 against
new 3.000 – 3.132).

Same data paired — best-of-7 wall time per session, summed over all 44:

**70,165 ms → 67,642 ms, −3.6%.** Every heavy session improved:

```
0.843  seed0014-dequa-fountain-explore    2769 -> 2335 ms
0.944  seed0360-wizard-world-tour         3926 -> 3708 ms
0.945  seed4500-knight-coverage           3462 -> 3273 ms
0.961  seed0030-ten-diverse-deaths       10204 -> 9808 ms
0.962  seed0367-priest-quest-tour         3263 -> 3140 ms
0.965  seed0373-barbarian-quest-tour      1907 -> 1841 ms
0.972  seed0361-archeologist-tour         2897 -> 2816 ms
```

### Playability — `frozen/playability_runner.mjs sessions/seed4500-…`

Five interleaved runs each: ad0f89d 1.893 / 1.897 / 1.902 / 1.928 / 2.026
ms/move; stage 2 1.766 / 1.790 / 1.797 / 1.801 / 1.813. **Best 1.893 → 1.766,
−6.7%**; the distributions do not overlap.

### CPU profile — `seed4500`, engine child process

`NODE_OPTIONS="--cpu-prof"` so the profile follows the child the runner spawns.

| | ad0f89d | stage 2 |
|---|---|---|
| total | 4,494 ms | 4,204 ms |
| `js/cptr.js` self time | 1,648 ms (36.7%) | 1,496 ms (35.6%) |
| `add` | 232 ms (**5.16%**) | 116 ms (**2.75%**) |
| GC | 378 ms (8.4%) | 337 ms (8.0%) |
| `ldPtro` | 166 ms (3.68%) | 155 ms (3.69%) |
| `st1o` | 144 ms (3.21%) | 80 ms (1.90%) |

`add`'s self time halves again — stage 1 took it from 11.6% to 4.3%, stage 2
takes it to 2.75%. No `o2`/`o3` function is individually large enough to enter
the top 20; the work is spread over 24 small functions, which is the point.

Stage 2 is a smaller win than stage 1 (−5.2% slope against −12.5%) for the
reason the site counts predict: stage 1 removed 141,239 allocations, stage 2
removes 13,872 more. The remaining `cptr.js` cost is no longer address
construction. It is the byte assembly inside the accessors — which is what
Task B went after.

---

## Task B: aligned typed-array views for one arena — measured, and dropped

The idea: hold `Int32Array`/`Uint32Array` views over the hottest byte buffer
and read 4- and 8-byte fields through them when the offset is aligned, instead
of assembling bytes. Stage 1's DataView attempt failed because the cached view
lived in a *property* on the byte buffer, and with thousands of buffers in
several shapes that property load was polymorphic in the hottest functions
there are. So this prototype deliberately avoided that: the guard is
`b === __arenaBuf`, an identity compare against a module-level slot, with no
property load on a foreign shape.

**First, the ceiling.** `js/cptr.js` was temporarily instrumented to tally
every fused-accessor fast-path entry by the buffer it lands in — 60,208,081
calls on `sessions/seed4500-knight-coverage`, segment 0:

| buffer | calls | share | distinct buffers of that size |
|---|---|---|---|
| 320 B (`struct obj` / `struct monst`) | 17,750,209 | 29.5% | **1,055** |
| 89,720 B (`svl`) | 3,318,089 | 5.5% | 2 |
| 112 B | 2,694,544 | 4.5% | 1,396 |
| 64 B | 2,226,075 | 3.7% | 2,884 |
| 40 B | 2,082,785 | 3.5% | 3,750 |
| 95,000 B (`gg`) | 1,994,588 | 3.3% | 2 |
| 32 B | 1,415,499 | 2.4% | 23,932 |

The single hottest buffer in the whole run is `svl`, at **5.51%** of accessor
calls. That is the entire budget an "aligned views for one big arena" change
has to work with, and it is not a measurement artifact of one session — the
port's storage *is* one object per `struct`, thousands of them.

**Then, the prototype.** `setArena(svl)` wired in at boot, views used by the
32-bit and 64-bit loads and stores (`ldI32*`, `stI32*`, `ldU64*`, `stU64*`,
`ldPtr*`) when `(o & 3) === 0`. Corpus stays green (44/44). Instrumented hit
rate: **1,581,413 hits against 32,316,235 misses — 4.7%.** Ninety-five percent
of the guard evaluations are pure overhead.

Five interleaved A/B pairs against stage 2 on `sessions/`:

| | startup_ms | per_move_ms | best-of-5 summed |
|---|---|---|---|
| stage 2 | median 780.1 | median **3.187** | 68,799 ms |
| + arena views | median 783.8 | median **3.229** | 69,211 ms |
| | +0.5% | **+1.3%** | **+0.6%** |

**Slower, within noise of nothing.** Dropped. The bar was a real-corpus win
above 3%; this is on the wrong side of zero.

The lesson is the same one DataView taught, sharpened: the byte-assembly cost
is real, but it is spread across tens of thousands of small buffers, and *any*
scheme that special-cases some buffers pays its guard on all of them. The
census above is the number to remember — 1,055 distinct 320-byte buffers
carrying 29.5% of all accessor traffic. No per-buffer trick reaches that.

## What this says about stage 3 (one linear-memory heap)

The Task B census is, unexpectedly, the strongest evidence *for* stage 3 so
far. Everything that made Task B fail — thousands of distinct buffers, a guard
that misses 95% of the time, polymorphic shapes in the hottest functions — is
exactly what a single linear heap deletes. With one `ArrayBuffer` behind every
pointer, the identity guard is unnecessary, the views are unconditional, the
accessor shapes are monomorphic, and `{buf, off}` collapses to a plain integer,
which takes the remaining allocation and the GC behind it with it.

The measured size of that prize, from this profile: `js/cptr.js` is still
35.6% of engine self time and GC is 8.0%, and address construction is now only
2.75% of it. So the reachable target is most of ~35% — not the ~5% the two
fusion stages were fighting over.

The cost is a re-architecture of every pointer in the port, a new `malloc`, and
a re-verification of all 69 sessions against a storage model that no longer
matches C's object identity in the places the port currently relies on it
(`eq`, `addr`, `decay`'s multi-dim flattening, the `__ptrRegistry` for pointers
stored in memory). That is weeks, and it is all-or-nothing: there is no useful
half-migrated state. It should not start until the parity work in ROADMAP 1.2
and the playability verdict in 1.4 are settled, because it puts every one of
those at risk simultaneously.

## Verification

1. **Differential fuzzer**, two parallel universes (`js/cptr.js` imported twice
   under different specifiers, so each side has its own module instance, its
   own `__ptrRegistry` and its own buffers). **500,003 cases, 0 mismatches**,
   over seven seeds, in two parts:
   - *contract* (350,000): every `o2`/`o3` against its literal composition —
     returned value, thrown message, and the full byte contents of all storage
     after each op. Operands include boxes, `boxProp`, function designators,
     int-bit-pattern pointers, plain-Array storage, subarray views, `null`,
     `undefined`, and objects with no `buf`; indices include BigInt, negative,
     fractional, `NaN`, string, boolean, `null`, `undefined` and `valueOf`
     objects; scales include `undefined`, 0, −1, 1.5 and 1000; stored values
     include BigInt, huge BigInt, negative, fractional, `NaN`, pointers and
     strings.
   - *rewrite* (150,003): `fuseOffsetAccess` driven directly on randomly built
     `cptr.<acc>(cptr.add(...))` source, old and new strings both evaluated,
     comparing value, bytes **and the order in which side-effecting
     subexpressions ran**. Order must match exactly whenever the expression
     completes. When the base is `null` the nested form stops evaluating
     arguments early where the flat form does not — that is stage 1's
     behaviour, unchanged here, and only ever reachable through a C null
     dereference, so the requirement there is that the old trace is a prefix of
     the new one.
2. **Build**: 172 files, 169 ok / 1 failed / 2 skipped — identical to ad0f89d.
   `C2JS_FOLD_VERIFY=1`: **301,692 folds, 0 mismatched, 0 unevaluable**, the
   same count as stage 1. A plain `--all --force` rebuild reproduces the
   committed tree byte-for-byte. (FOLD_VERIFY still emits a few extra unused
   imports in 12 files — see stage 1's note — so only plain-build output is
   committed.)
3. **Suites**: test-rnd, test-hacklib (870 cases), test-setjmp, test-union,
   `node --test` (8/8), posix-ere (23,996 differential cases).
4. **Corpus**: `sessions/ sessions-extra/` **69/69 byte-exact, twice.**
5. **Browser**: `tools/judge-sim/run.mjs seed8000-tourist-starter` PASS, 0
   segment mismatches, 0 out-of-scope requests; `judge-sim/playability.mjs
   --keys=hjklhjklhjkl` engages the `xhr` transport, `"console_entries": []`.

## Stage 3 candidates that are *not* the heap

If the linear-memory rewrite stays parked, what is left at this scale:

1. **`ldPtro` — 3.7% and now the largest single accessor.** Every stored
   pointer round-trips through `__ptrRegistry`, and the read is eight byte
   loads plus a registry index computation. The registry exists because a
   pointer has to survive being written into a byte buffer; a linear heap
   removes it entirely, and nothing short of that removes it cheaply.
2. **Startup — 767 ms against a 3.10 ms slope.** On a typical 200-move session
   that is 55% of the bill, and `compileSourceTextModule` is 6.1% of the
   profile. Source shrink still pays the intercept directly (stage 2's 228 KB
   is part of the −2.7%), but the remaining startup cost is genuine engine work
   in `newgame`, which needs its own profile before anyone guesses at it.
3. **`decay` at 1.0% and `cstr` at 1.6%** are string/array-conversion helpers
   with real call counts and no allocation to fuse away. Small, and probably
   the honest next target if stage 3 stays parked.
