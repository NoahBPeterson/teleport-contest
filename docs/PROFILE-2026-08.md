# Profile, August 2026 — where the time and the memory actually go

Everything on this page was measured fresh, on this machine, at `52c0cb6`
(`main`) and its `speed-stage3` prototype. Node v26.5.0, darwin 25.5.0, 10
cores, 16 GB. Load average at the start of the run was 4.0 (other agent
sessions on the box); every comparison below is therefore either an
**interleaved A/B** or a **profile**, both of which are robust to a constant
background load. Absolute wall times drift a few percent between sections; the
ratios do not.

Baselines this page is checked against:

- `docs/NOTES-speed-stage1.md` / `NOTES-speed-stage2.md` — the two address-fusion
  stages. Stage 2's reference profile was seed4500 at 4,204 ms total, `cptr.js`
  35.6% of self time, `add` 2.75%, GC 8.0%.
- `docs/NOTES-async-engine.md` — the yieldable engine (+14% slope, ~50 MB per
  forked graph, boot 931 ms on seed8000).
- `docs/NOTES-playability-quickwins.md` — the older profile, taken on a
  contended machine (`cptr.js` 44%, `add` 12.6%).

Headline: **the scored corpus now fits `691 + 2.73 ms/turn` (R² = 0.712, 44/44
byte-exact)**, against stage 2's `767 + 3.10`. The two fusion stages have
banked what they were going to bank; the remaining cost is somewhere else, and
this page is about where.

---

## 1. Startup anatomy

### 1.1 The scoring path, wall clock

`frozen/ps_test_runner.mjs` spawns one child per session and times only the
`runSegment` loop, so its `startup_ms` intercept (691 ms) *excludes* Node's own
bootstrap and the `import()` of `js/jsmain.js`. The probe below measures the
whole child, and uses a pre-warmed `import()` of `js/generated/unixmain.js` under
the isolated specifier to split module-graph instantiation from `newgame()`.
The pre-warm is legitimate: it produces the identical RNG log (3,130 calls on
seed8000), so the reordering of `cptr` allocations it causes changes nothing
the game can see.

`sessions/seed8000-tourist-starter` (22 moves), representative run:

| phase | ms | share |
|---|---|---|
| Node process bootstrap (`nodeTiming.bootstrapComplete`) | 14.4 – 19.5 | 2% |
| script entry, session JSON parse, `isolation.mjs` | 1.1 – 2.4 | <1% |
| `js/jsmain.js` graph (harness side, no generated code) | 0.8 – 2.7 | <1% |
| `enableSegmentIsolation()` (installs the resolve hook) | 0.2 – 0.4 | <1% |
| `js/boot/harness.mjs` + `js/cptr.js`, isolated specifier | 11.0 – 15.0 | 2% |
| **`js/generated/**` graph instantiation — 176 modules** | **337 – 401** | **46%** |
| `runBootGame()` with 0 moves — `main()` → `newgame()` → first frame | 312 | 42% |
| 22 moves | ~48 (2.2 ms/move) | 6% |
| **whole child** | **715 – 825** | |

Two facts to keep: **module-graph instantiation is the single largest item in a
session's startup**, and it is paid once per *segment*, not once per process —
`js/boot/isolation.mjs` forks a fresh 176-module graph for every segment, which
is what buys per-segment isolation under `node --permission`.

### 1.2 The scoring path, CPU profile

`NODE_OPTIONS="--cpu-prof --cpu-prof-interval=200"`, seed8000 child, 872.7 ms
sampled over 3,518 samples.

Top self time:

| ms | % | function | file |
|---|---|---|---|
| 229.2 | **26.27** | `compileSourceTextModule` | node:internal/modules/esm/utils |
| 34.7 | 3.98 | (garbage collector) | |
| 23.1 | 2.65 | `add` | js/cptr.js |
| 18.2 | 2.08 | `ldPtro` | js/cptr.js |
| 14.8 | 1.69 | `internalModuleStat` | (node) |
| 14.1 | 1.61 | `stU64o` | js/cptr.js |
| 10.6 + 9.7 | 2.34 | `getPackageScopeConfig` ×2 | node:internal/modules/package_json_reader |
| 9.0 | 1.03 | `parse` (JSON, package.json) | (node) |
| 8.1 | 0.93 | `llex` | js/generated/llex.js |

> **`compileSourceTextModule` is V8, not `tools/c2js`.** The C→JS transpile is
> AOT and happens at *our* build time; the judge never runs it. This line is
> V8 parsing and compiling the 13.2 MB of JavaScript we ship, into bytecode,
> at load time — the unavoidable cost of "the judge just loads our generated
> JS". What makes it big is not that it happens, but *how often*: see §5.1.

Buckets: **V8 parse/compile of our emitted JS 28.7%**, `js/generated/**` 27.7%, `js/cptr.js` 18.8%,
Node internals (resolution, `stat`, `package.json`) 17.3%, GC 4.0%,
`js/boot/**` 2.2%.

Inclusive time, from the call tree:

```
600.0 ms  68.8%  runBootGame
411.2 ms  47.1%    main
240.4 ms  27.5%      newgame
105.1 ms  12.0%        mklev  -> makelevel 100.7 -> makerooms 75.9
 70.4 ms   8.1%        init_dungeons -> nhl_init 51.0 -> nhl_loadlua 35.6
 25.1 ms   2.9%        l_nhcore_init -> nhl_init 19.8
 11.0 ms   1.3%        save_currentstate
 97.9 ms  11.2%      initoptions
 56.5 ms   6.5%      moveloop (22 moves)
229.7 ms  26.3%  compileSourceTextModule (mostly under the graph import)
```

**Top five startup costs, ranked**

1. **`compileSourceTextModule` — 229 ms, 26.3%.** V8 parsing and compiling the
   13.2 MB of JavaScript we ship. Not `tools/c2js`: the C→JS transpile is AOT
   and happens at our build time, and the judge never runs it. This is what
   *loading* our output costs any JS engine — and we pay it **once per segment**,
   not once per process (§5.1). It is what source-size reductions buy directly,
   and it is why stage 1's −1.27 MB and stage 2's −228 KB both moved the
   intercept.
2. **Node's ESM machinery — ~151 ms, 17.3%.** `internalModuleStat`,
   `getPackageScopeConfig` (twice, in two different realms of the loader),
   `JSON.parse` of `package.json`, `pathToFileURL`, `normalizeString`. 176
   modules × a `?c2jsseg=N` query means 176 fresh resolutions per segment; the
   loader re-walks the package scope for each.
3. **`mklev` / `makelevel` — 105 ms, 12.0%**, three quarters of it in
   `makerooms`. Genuine game work, and it recurs on every level change, not just
   at `newgame`.
4. **`initoptions` — 98 ms, 11.2%.** Option table setup and `.nethackrc` parse.
5. **The transpiled Lua interpreter — ~87 ms, 10%** across `nhl_init`,
   `nhl_loadlua` and `l_nhcore_init` (dungeon.lua, nhcore.lua, quest text).
   `luaL_loadbufferx` → `llex`/`lparser`/`lcode` is a second compiler running
   inside the first one.

Items 1 and 2 together are **44% of a short session's CPU and are not game
work at all.**

### 1.3 The browser

`tools/judge-sim/playability.mjs`, real headless Chrome 151.0.7922.77, default
mirror shape (no COOP/COEP, so no SharedArrayBuffer — the configuration
mazesofmenace.ai actually serves). Three runs, harness-reported (the page's own
`performance.now()`):

| field | run 1 | run 2 | run 3 |
|---|---|---|---|
| `engine_mode` | xhr | xhr | xhr |
| `first_frame_ms` (nav start → first painted frame) | 702 | 746 | 708 |
| `start_to_frame_ms` | 637 | 689 | 653 |
| `head_ms` | 34 | 28 | 30 |
| `module_entry_ms` | 38 | 30 | 31 |
| `imports_ready_ms` | 60 | 52 | 49 |
| `start_entry_ms` | 65 | 57 | 55 |
| `ms_per_move` (incl. CDP round trip) | 1.608 | 2.142 | 1.883 |
| `engine_ms_per_move` | 0.142 | 0.158 | 0.167 |

Per rung (one run each):

| | default (xhr) | `--transport=worker` | `--transport=main` | `--transport=replay` |
|---|---|---|---|---|
| `first_frame_ms` | 702 – 746 | 679 | 643 | 759 |
| `start_entry_ms` | 55 – 65 | 46 | 46 | 70 |
| `main_graph_ms` | — | — | 15 | — |
| `main_boot_ms` | — | — | 548 | — |
| `ms_per_move` | 1.61 – 2.14 | 1.583 | **0.217** | **212.5** |
| in-scope requests | 388 | 380 | 199 | 1112 |

`console_entries` was `[]` and `out_of_scope` was `[]` in **all seven runs** —
the two gate conditions hold.

The shape matches Node's exactly: **the pre-engine diet is ~46–70 ms** (head,
module entry, imports ready) and **the remaining ~590–690 ms is engine boot** on
every rung. One caveat worth carrying: `main_graph_ms` (12–15 ms) is *not* the
176-module graph — `js/boot/main-thread-engine.mjs:330` times only
`prewarmMainThread()`, which imports `js/boot/harness-y.mjs`, and that module
pulls `js/generated-y/**` lazily from inside `runBootGame`. So `main_boot_ms`
(548 ms) carries graph instantiation *and* `newgame()` together. A
`--no-prewarm` control confirms it: 12/539 against 15/548, i.e. essentially
nothing on this path is prewarm-avoidable today.

`--transport=replay` is not slow to first frame (759 ms); it is slow *per
keystroke* — 212.5 ms/move, with `p95 == max == 665.7 ms` on a single key,
because the fallback re-runs the game from the beginning to advance. That is
the 1,112-request row too.

### 1.4 The sandboxed-Node yield path

`docs/NOTES-async-engine.md` recorded 931 ms for `seed8000-tourist-starter` on
the yield rung. It reproduces. Same probe as §1.1, `js/jsmain-yield.mjs` →
`js/boot/harness-y.mjs` → `js/generated-y/`, paired against the sync engine in
the same shell:

| phase | sync | yield | delta |
|---|---|---|---|
| Node bootstrap + harness graph | 31.5 | 43.0 | +11.5 |
| **generated graph instantiation (176 modules)** | 400.9 | 412.0 | **+2.8%** |
| `runBootGame()` — `newgame()` + 22 moves | 355.6 | 448.8 | **+26.2%** |
| **total child** | **788.0** | **903.8** | **+14.7%** |

So the 931 ms decomposes as: **~45 ms fork + harness, ~410 ms graph
instantiation, ~330 ms `newgame()`, ~120 ms of 22 moves**, and the generator
transform's cost is almost entirely in the *executing* part, not the
instantiating part — the graph costs 2.8% more to instantiate and 26% more to
run. That is consistent with the +14% slope in the async notes.

GC is not the story here: at 4.0% of a short session it cannot account for the
+116 ms.

---

## 2. Per-move anatomy

`sessions/seed4500-knight-coverage`, 1,813 moves, engine child under
`--cpu-prof --cpu-prof-interval=200`: 3,892.3 ms sampled, 15,209 samples,
26,514 nodes. Startup is ~700 ms of that, so roughly 82% of what follows is
per-move work.

### 2.1 Top 25 by self time

| ms | % | function | file | group |
|---|---|---|---|---|
| 331.3 | **8.51** | (garbage collector) | | GC |
| 227.4 | **5.84** | `compileSourceTextModule` | node ESM | startup |
| 138.5 | **3.56** | `ldPtro` | js/cptr.js | cptr |
| 106.0 | 2.72 | `add` | js/cptr.js | cptr |
| 81.4 | 2.09 | `cstr` | js/cptr.js | cptr |
| 74.8 | 1.92 | `st1o` | js/cptr.js | cptr |
| 72.8 | 1.87 | `stU64o` | js/cptr.js | cptr |
| 71.5 | 1.84 | `sprintfCore` | js/cptr.js | cptr |
| 68.3 | 1.75 | `st1` | js/cptr.js | cptr |
| 54.7 | 1.40 | `read` | (node syscall) | harness I/O |
| 54.4 | 1.40 | `g.fwrite` | js/boot/harness.mjs | harness I/O |
| 54.2 | 1.39 | `nomux_capture_screen` | js/generated/termcap.js | game |
| 53.0 | 1.36 | `memcpy` | js/cptr.js | cptr |
| 51.8 | 1.33 | `ldI32o` | js/cptr.js | cptr |
| 49.2 | 1.26 | `ld1so` | js/cptr.js | cptr |
| 49.1 | 1.26 | `runBootGame` | js/boot/harness.mjs | harness |
| 44.1 | 1.13 | `bytesToB64` | js/boot/harness.mjs | harness (save overlay) |
| 44.0 | 1.13 | `runSession` | frozen/ps_test_runner.mjs | scorer |
| 43.9 | 1.13 | `ld1uo` | js/cptr.js | cptr |
| 43.5 | 1.12 | `decay` | js/cptr.js | cptr |
| 40.4 | 1.04 | `strlen` | js/cptr.js | cptr |
| 39.8 | 1.02 | `ldPtr` | js/cptr.js | cptr |
| 32.0 | 0.82 | `__flushLines` | js/generated/rnd.js | RNG log |
| 30.7 | 0.79 | `ldU64o` | js/cptr.js | cptr |
| 30.2 | 0.78 | `decodeScreen` | frozen/screen-decode.mjs | scorer |

### 2.2 Grouped

| group | ms | % |
|---|---|---|
| `js/cptr.js` | 1,365 | **35.08** |
| `js/generated/**` (game logic) | 1,169 | **30.04** |
| GC | 331 | 8.51 |
| Node internals | 281 | 7.21 |
| V8 parse/compile of our emitted JS (not the transpiler) | 252 | 6.48 |
| `js/boot/harness.mjs` | 225 | 5.78 |
| terminal / screen decode (scorer side) | 129 | 3.30 |

Generated modules, by self time: `termcap.js` 2.19% (screen capture),
`display.js` 2.18%, `rnd.js` 1.51%, `llex.js` 1.23% + `ldo/lparser/lcode/lvm/lgc`
another ~3.5% (the Lua interpreter), `monmove.js` 0.88%, `cmd.js` 0.72%.

Inclusive: `runBootGame` 76.4%, `main` 69.1%, `moveloop`/`moveloop_core` 59.0%,
`rhack` 22.4%, `makelevel` 22.1% (this session descends a lot), `newgame` 6.2%.

### 2.3 Deltas against the stage-2 baseline

Stage 2's profile of the same session, same tool:

| | stage 2 (`ad0f89d`→stage 2) | now | verdict |
|---|---|---|---|
| total | 4,204 ms | **3,892 ms** | −7.4% |
| `js/cptr.js` self | 35.6% | **35.08%** | holds |
| `add` | **2.75%** | **2.72%** | **confirmed** |
| GC | 8.0% | 8.51% | holds |
| `ldPtro` | 3.69% | 3.56% | holds, still the largest accessor |
| `st1o` | 1.90% | 1.92% | holds |
| `compileSourceTextModule` | 5.80% | 5.84% | holds |

Stage 2's headline claim — `cptr.add` down to 2.75% of the profile — **verifies
exactly**. Nothing has regressed. The distribution stage 2 predicted for stage 3
is the distribution that is still there: address construction is done, and what
is left inside `cptr.js` is byte assembly spread over ~30 small functions, none
individually above 3.6%.

### 2.4 Dynamic accessor counts

`js/cptr.js` instrumented with call counters (temporarily; reverted), seed4500,
1,813 moves:

| accessor | calls |
|---|---|
| `ld1uo` | 13,163,878 |
| `ldPtro` | 8,669,643 |
| `ldI32o` | 7,665,048 |
| `st1o` | 2,190,650 |
| `ldU64o` | 2,166,362 (incl. 872,599 delegated from `ldI64o`) |
| `stU64o` | 1,599,068 |
| `ldI32o2` | 678,403 |
| `ldU64o2` | 448,275 |
| `ldU64` | 436,558 |
| `ldI64o2` | 382,206 |
| `ldI64` | 52,682 |
| **all 64-bit loads** | **4,358,682** |

For scale, stage 2's census counted 60.2 M fused-accessor calls on this session,
so the 64-bit loads are ~7% of accessor traffic. That number is the reason
§4(a) below fails.

### 2.5 Sync engine against yield engine

Same session shape (seed8000, 22 moves), same probe:

| | sync | yield |
|---|---|---|
| graph instantiation | 400.9 ms | 412.0 ms (+2.8%) |
| `newgame()` + moves | 355.6 ms | 448.8 ms (+26.2%) |
| retained heap per realm | 69.8 MB | 77.3 MB (+10.8%) |

The generator transform's overhead is concentrated in execution, and it is a
per-call cost (generator allocation and `yield*` delegation on every coloured
call), so it lands on `js/generated-y/**` rather than on `js/cptr.js` — the
accessors are not coloured and are untouched by the transform.

---

## 3. Memory

### 3.1 The scoring path

The judge's path spawns a child per session, so nothing accumulates. Peak in one
child, after the session:

| session | moves | heapUsed | RSS |
|---|---|---|---|
| seed8000-tourist-starter | 22 | 114.9 MB | 250.3 MB |
| seed4500-knight-coverage | 1,813 | 342.4 MB | 531.5 MB |
| seed0030-ten-diverse-deaths | 1,943 (10 segments) | 1,156.3 MB | 1,019.7 MB |

seed0030 is the warning shot: **it is a single session, and it forks ten graphs
inside one child**, one per segment, because that is how per-segment isolation
works. A 10-segment session costs the same heap as ten separate games.

### 3.2 Retained per forked realm — measured, and it is not the yield engine's fault

Same 22-move session replayed N times in one process, `--expose-gc`, forced
collection between runs:

| run | sync heapUsed | Δ | yield heapUsed | Δ |
|---|---|---|---|---|
| 1 | 81.6 MB | +77.3 | 89.3 MB | +85.0 |
| 2 | 151.4 MB | **+69.8** | 166.7 MB | **+77.4** |
| 3 | 221.3 MB | +69.8 | 244.1 MB | +77.4 |
| 5 | 360.8 MB | +69.7 | 398.7 MB | +77.3 |
| 10 | 709.6 MB | +69.7 | 785.4 MB | +77.3 |

**69.8 MB per realm on the *sync* engine, 77.3 MB on the yield engine** — flat
to three digits, run after run. This updates `NOTES-async-engine.md` in one
important way: the ~50 MB (later ~80 MB) per-game growth it attributes to the
yieldable rung is **not a property of the yield build**. It is the cost of
forking a module graph that Node can never unload, and the synchronous engine
pays 90% of it. The yield build's own contribution is the +7.5 MB of generator
machinery and a larger emitted source.

Boot time stayed flat across all ten runs on both engines here (680–850 ms) —
the collapse the async notes describe begins later, once the live set is large
enough that each fresh 70 MB allocation drags a major GC. On this 16 GB machine
that is around session 20, exactly as recorded.

Ten *real* sessions in one process (not the same one repeated) reached
**1,158.9 MB heapUsed** from a 4.1 MB base, with per-session growth of 70–110 MB
depending on how much the game allocated.

### 3.3 Buffer census

`cptr.alloc` / `cptr.malloc` / `cptr.lit` counted directly (instrumentation
reverted afterwards):

| | seed8000 (22 moves) | seed4500 (1,813 moves) |
|---|---|---|
| `alloc` calls / bytes | 30,892 / 1.94 MB | 306,335 / 12.26 MB |
| `malloc` calls / bytes | 16,689 / 1.43 MB | 45,863 / 5.50 MB |
| `lit` calls / bytes | 24,448 / 397 KB | 30,889 / 500 KB |
| **`__ptrRegistry` entries** | **186,811** | **1,037,119** |
| `__intPtrs` | 29 | 304 |

Two things stand out.

**The byte buffers are not the memory.** seed8000 allocates 3.8 MB of actual
game bytes but retains 69.8 MB per realm. The other ~66 MB is the module graph
itself — compiled bytecode and optimised code for 176 modules, their closures,
their string-literal tables — plus the CPtr wrapper objects (72,029 of them on
seed8000) and the pointer registry.

**`__ptrRegistry` is a million-entry array on a long session.** Every pointer
ever written into a byte buffer gets an index there, and the array is
append-only by construction (`js/cptr.js:1289`) because an index *is* the
pointer's identity. At 1.04 M entries it is ~8 MB of slots, and it strongly
retains every `CPtr` it holds — including everything C freed long ago.
`__releaseSpentGraph()` exists precisely to drop it, and its only caller is an
engine tearing a finished game down.

---

## 4. Emit-time optimisation scouting

Three candidates, evaluated against the profile above. All prototyping is on
`speed-stage3`; `main` is untouched.

### (a) 64-bit constant-mask narrowing — implemented, verified, and **not worth merging**

**The shape.** `display.js`'s `tp_sensemon` is the motivating case:

```js
(cptr.ldU64o((cptr.ldPtro(mon, 8)), 72) & 65536n) != 0n
```

`mon->data->mflags2 & M2_...`. The field is a C `unsigned long`, so the port
loads it as a BigInt (`ldU64o` allocates one on every call), ANDs with a BigInt
literal, and compares against `0n`.

**Site count.** A census of `js/generated/**` finds **1,386** occurrences of
`(<64-bit load> & <literal>n) != 0n`. Of those, **1,386 have a mask that fits
entirely in the low 32 bits — 100%. Zero live in the high half, zero straddle.**
A further 62 sites use a *negative* BigInt mask (`& -117440513n`), which has all
high bits set and cannot narrow. The emitter's rewrite fires on **1,380** of them
(the six it declines are shapes where the load is not the whole left operand).

Top files: `mon.js` 107, `trap.js` 99, `polyself.js` 75, `hack.js` 70,
`mondata.js` 62, `uhitm.js` 57, `muse.js` 54. Top masks: `1` ×148, `2` ×97,
`256` ×72, `4096` ×68, `8192` ×67.

**The C semantics proof.** `narrowMaskedLoad()` in `tools/c2js/emit.mjs` carries
it in full; in short:

- *Little-endian by construction.* `ldU64o` assembles its low word from bytes
  `o..o+3` and its high word from `o+4..o+7`. `ldI32o` reads exactly `o..o+3`.
  Same bytes, same order, no reinterpretation of the field's layout.
- *Mask confinement.* If `K < 2^32` then `K` has no bit above 31, so no bit of
  the high word can contribute to `field & K`. The 64-bit AND is zero iff the
  32-bit AND of the low word is.
- *Signed narrow load is fine.* `ldI32o` returns those four bytes as a signed
  int32 — the same bit pattern, differently interpreted — and JS `&` operates on
  `ToInt32` of both operands, so `ldI32o(p,k) & K` carries the bit pattern of
  `low32(field) & K` for every `K` in `[1, 2^32)`, including `K ≥ 2^31` where
  `ToInt32(K)` is negative. The test is `!== 0`, which reads that pattern
  correctly either way.
- *Signed vs unsigned source.* `ldI64o` is exactly `BigInt.asIntN(64, ldU64o)`,
  which leaves the low 64 bits untouched; BigInt `&` is two's-complement, so
  `asIntN(64,u) & K === u & K` for any `K` with no bits at or above 64. Both
  spellings narrow to the same `ldI32o`.
- *Boxes.* Only the **fused** forms (`o`/`o2`/`o3`) are narrowed. The unfused
  `ldU64(p)`/`ldI64(p)` can be handed a box — an address-taken 64-bit local,
  whose `.v` is a BigInt — and `ldI32`'s box arm is `p.v | 0`, which throws on a
  BigInt. The fused forms cannot reach a live box: the fast path needs `p.buf`,
  and the slow path goes through `cptr.add`, which drops `isBox` and leaves
  `{buf: undefined}` for the accessor to fail on. Both spellings throw a
  TypeError there today; narrowing creates no path that did not already throw.
- *The one real behaviour change.* `ldU64o` bounds-checks (`o + 8 > b.length`
  calls `__oob64`); `ldI32o` does not. A 64-bit field in the last seven bytes of
  a buffer would have thrown and now reads zeros past the end. C struct layout
  puts no `unsigned long` there, and the 69-session corpus is the gate.

**Where it lives.** `narrowMaskedLoad()` (`tools/c2js/emit.mjs`), wired into
`expr_BinaryOperator`'s comparison arm next to the existing `ptrCmp` handling,
guarded on one side being the literal `0n` — which the emitter only ever emits
for a 64-bit-typed constant, so no type lookup is needed. `EMIT_VERSION` 8 → 9.

`tools/c2js/narrow64.mjs` applies the *same exported function* to an
already-emitted tree, because this worktree has no clang ASTs
(`nethack-c/upstream` is an uninitialised submodule, `.cache/c2js` absent) and
the standing rule is not to re-dump them. It is a `yieldify.mjs`-shaped
post-pass and it cannot drift from the emitter, since it imports the rewrite
rather than restating it. **Before this is merged anywhere, a real
`build.mjs --all` on a tree that has the ASTs must reproduce the same bytes.**

**Parity.** `sessions/ sessions-extra/` — **69/69 byte-exact**. `narrow64.mjs
--check` is idempotent (0 further sites) after application.

**And now the number that kills it.** Counting calls dynamically, seed4500:

| | base | narrowed | delta |
|---|---|---|---|
| `ldI32o` | 7,665,048 | 7,793,072 | **+128,024** |
| `ldI32o2` | 678,403 | 680,843 | **+2,440** |
| all 64-bit loads | 4,358,682 | 4,218,256 | −140,426 |

**~131,000 narrowed-site executions in a 1,813-move session — 72 per move, 3%
of the 64-bit loads, 0.2% of all accessor traffic.** A microbenchmark of the
exact shapes on 1,055 distinct 320-byte buffers (the port's real buffer
population) puts the saving at **8.29 → 3.28 ns per site**:

```
ldU64o & Kn != 0n  (today)        8.29 ns/op
ldI64o & Kn != 0n  (today)        8.21 ns/op
ldI32o & K !== 0   (narrowed)     3.28 ns/op
ldI64o2 truthiness (uprops)       8.45 ns/op
ldI32o2 truthiness (narrowed)     3.21 ns/op
```

131,000 × 5.0 ns = **0.66 ms out of ~2,900 ms — 0.023%.** That is two orders of
magnitude below the run-to-run noise of the corpus.

**The A/B, and what it is worth.** Two rounds.

*Round 1* — five interleaved pairs of `node frozen/ps_test_runner.mjs sessions/`
(44 sessions), base first in every pair:

| pair | base startup / slope / wall | narrow startup / slope / wall |
|---|---|---|
| 1 | 727.8 / 2.809 / 63,899 | 702.9 / 3.262 / 67,947 |
| 2 | 679.6 / 3.098 / 65,066 | 793.3 / 3.676 / 76,627 |
| 3 | 824.7 / 2.872 / 68,876 | 837.0 / 5.509 / 99,349 |
| 4 | 960.1 / 3.317 / 79,888 | 1450.7 / 3.656 / 105,315 |
| 5 | 779.4 / 5.274 / 94,149 | 793.8 / 3.732 / 77,285 |

**This round is unusable and it is important to say why.** The base wall time
climbs monotonically — 63,899 → 65,066 → 68,876 → 79,888 → 94,149 — because the
machine's background load rose through the run. With base always first in the
pair, the second arm systematically got the worse slot. Interleaving cancels a
*constant* offset, not a *trend*.

*Round 2* — eight **ABBA-ordered** pairs (base-narrow, narrow-base, …) on
`frozen/playability_runner.mjs sessions/seed4500-knight-coverage`, which is
engine-only in one process and takes ~4 s, so sixteen runs fit where two corpus
runs did:

```
base    4439 3643 4087 3688 3641 3738 3501 3643     median 3665.5   min 3501
narrow  4992 3893 3784 3668 4314 4494 3715 3387     median 3838.5   min 3387
```

Median says narrow is 4.7% *slower*; minimum says narrow is 3.3% *faster*. The
two statistics disagree in sign, the distributions overlap almost completely,
and a paired t on the means gives t ≈ 1.1, p ≈ 0.3. **No effect is resolvable.**
That is the correct outcome for a change whose arithmetic predicts 0.023%: the
machine's noise floor here is ±10%, which is four hundred times the signal.

**Parity gate: `sessions/ sessions-extra/` 69/69 byte-exact, twice.** The
yieldable build (`js/generated-y/`, narrowed by the same pass) also passes
`yieldtest/ps_test_runner.mjs` on seed4500 and seed0030. `node --test`
`test/cmachine`, `test/libc-string`, `test/posix-ere`, `test/printf` — 4/4.
`C2JS_FOLD_VERIFY` could not be run: it needs a build from the clang ASTs, which
this worktree does not have, and `verifyFold` only audits closed constant
expressions anyway — it could not have audited this rewrite, whose operands are
runtime loads. The differential harness that *would* audit it is the
stage-2-style rewrite fuzzer, which is not checked into the repo.

**Verdict: correct, safe, byte-exact, and worth nothing measurable.** The
intuition that "mondata `M1_*`/`M2_*` checks are everywhere" is right about the
*source* — 1,386 sites is a lot of source — and wrong about the *execution*: the
port's hot loads are `ld1uo` (13.2 M, the level map and glyph bytes), `ldPtro`
(8.7 M) and `ldI32o` (7.7 M). Flag tests are simply not where the moves go. The
change is committed on `speed-stage3` as a documented negative, not proposed for
`main`.

### (b) Boolean-context `? 1 : 0` elision — **worthless for the slope, worth ~1.4% of the source for startup**

C11 6.5.13/14 says `&&` and `||` yield an `int` 0 or 1, and JS yields the raw
operand, so `emit.mjs:1839` appends `? 1 : 0` to **every** `&&`/`||` it emits,
unconditionally. There is no consumer-side context in the emitter today: no
`boolCtx`, no `asCond`, no `wantBool` — `emitPlainIf` (emit.mjs:3439) and
`stmt_WhileStmt` (emit.mjs:3501) just take `.code` raw. The `bool: true` flag
that does exist is a *producer*-side marker, used only by `jsIndex()`.

**Census of `js/generated/**`** (29,824 occurrences of `? 1 : 0`), classified by
what consumes the enclosing paren group:

| consumer | count | elidable? |
|---|---|---|
| operand of `&&` / `\|\|` | 14,174 | yes |
| `if` / `while` / `for` condition | 9,326 | yes |
| operand of `!` | 1,832 | yes |
| test of a `?:` | 1,322 | yes |
| **subtotal — boolean context** | **26,810 (89.9%)** | **yes** |
| value position (assignment, arithmetic, array index) | 2,862 | no |
| call argument | 84 | no |
| `return` | 72 | no |
| unparenthesised | 152 | no |

**Slope: no.** `x && y ? 1 : 0` consumed as a condition costs V8 a select that
folds into the branch it feeds. There is no allocation, no call, no megamorphic
site. Nothing in the top-25 self-time list is attributable to it, and nothing
would be.

**Startup: yes, and this is the interesting half.** 26,810 × 7 bytes = **183 KB**
off a 13.22 MB tree — 1.4%. For scale, stage 2 removed 228 KB (1.7%) and that
was part of its −2.7% startup. §1 shows why the coupling is real: V8 has to
parse and compile every byte of the tree we ship (26.3% of a short session's
CPU), and §5.1 shows it does so **once per segment**. Fewer bytes shipped is
less parsing, linearly, every fork. A 1.4% source reduction is a ~1.4%
reduction in the largest single startup item.

**But it is not free to implement.** The emitter has to grow a consumer-side
context — `opts.boolCtx` threaded from `emitPlainIf` / `stmt_WhileStmt` /
`stmt_ForStmt` / the `?:` test / the operands of `&&`, `||` and `!` down through
`emitExpr` — because a text-level rewrite cannot see the consumer. That is a
change to the emitter's calling convention rather than a peephole, it touches
every statement emitter, and the failure mode when it gets a context wrong is a
silent value change (`schar(a && b)` becoming `schar(true)`), not a crash.

**Verdict: worth doing, but as a *startup* change, priced against the other
startup levers in §5 — and it is the smallest of them.** 183 KB is 1.4% of the
tree; §5's first two items are worth 44% of a short session's CPU between them.
Do those first. If (b) is done, it needs the same corpus gate and a fixture that
pins the emitted text at every context kind in the table above, because "the
emitter now believes this is a condition" is exactly the kind of belief that
should be pinned.

### (c) Within-statement load CSE — **the best of the three, and the only one whose targets are hot**

The motivating case is real and it is everywhere. `mondata.js:resists_drli`:

```js
((cptr.ldI32o((ptr), 80) & 2) !== 0) || ((cptr.ldI32o((ptr), 80) & 256) !== 0) || ((cptr.ldI32o((ptr), 80) & 4) !== 0)
```

three identical loads, no call between them. `display.js:sensemon` has the same
shape on `cptr.ldI16o((mon), 28)` / `(mon), 30)` four times over, plus the
doubled `uprops` reads the brief named.

**Static census of `js/generated/**`** — identical `cptr.ld*(…)` call text
appearing more than once on one emitted line:

| | count |
|---|---|
| lines containing any load | 40,790 |
| duplicate groups | 6,217 |
| redundant loads (occurrences beyond the first) | **9,732** |
| … with no intervening non-`cptr` call (hoistable under the conservative rule) | **7,889 (81%)** |

By accessor — and this is why (c) is not (a):

| accessor | redundant loads | its self time in §2.1 |
|---|---|---|
| `ldPtro` | 2,436 | **3.56%** — the largest accessor in the profile |
| `ldI16o` | 2,215 | 0.51% |
| `ldI32o` | 1,366 | 1.33% |
| `ld1so` | 1,150 | 1.26% |
| `ldI16` | 396 | 0.14% |
| `ldU64o` | 296 | 0.79% |
| `ld1uo` | 260 | 1.13% |

Top files: `display.js` 444, `sp_lev.js` 358, `dothrow.js` 353, `trap.js` 349,
`mon.js` 338, `objnam.js` 322, `zap.js` 286, `uhitm.js` 280.

Case (a) targeted accessors carrying 3% of 64-bit-load traffic and 0.2% of all
accessor calls. Case (c) targets `ldPtro`, `ldI32o`, `ld1so` and `ld1uo` — four
of the six hottest functions in the whole profile, together **31 M calls per
seed4500 session**.

**The hazard that has to be respected.** Hoisting a load to a temporary makes it
*unconditional*. In `A || B` where `B` contains the repeated load, `B` may not
be evaluated at all, and `cptr.ldPtro(null, 8)` throws. So the sound rule is
*hoist to the first occurrence's position, not above the expression* — the
first occurrence is unconditionally evaluated by construction, so
`(t = L) … t` preserves both the value and the throw behaviour. That needs a
function-scoped `let t` and an assignment inside an expression; the emitter
already declares locals per function, so the machinery is there.

The second hazard is aliasing: any call between two occurrences can write the
loaded bytes. The 81% figure above is already the call-free subset, and `cptr.*`
loads are the only calls permitted inside the window.

**The dynamic ceiling, measured.** The lesson of (a) is that a static count is
not a prediction, so the same question was asked of (c) *before* building it.
`js/cptr.js` was instrumented (temporarily; reverted) so that `ld1uo`, `ld1so`,
`ldI16o`, `ldI32o`, `ldPtro`, `ldU64o` and their `o2` forms record the
`(buffer identity, byte offset, accessor)` key of every fast-path load into a
16-entry ring, and count how far back the same key was last seen. That is the
ceiling for *any* load-CSE scheme, whatever its window:

| | seed4500 (1,813 moves) | seed0002 (594 moves) |
|---|---|---|
| instrumented loads | 42,921,674 | 14,518,558 |
| same key as the **immediately preceding** load | **8,080,225 — 18.83%** | 2,948,368 — 20.31% |
| same key within the last 4 loads | 12,806,831 — 29.84% | 4,449,648 — 30.65% |
| same key within the last 16 loads | 22,456,245 — 52.32% | 6,883,637 — 47.41% |

**Nearly one load in five is an exact repeat of the one before it**, and half of
all loads repeat one from the last sixteen. The two sessions agree to within two
points, so this is a property of the port, not of a keyplan.

Priced at the ~4 ns an eliminated accessor call costs (the microbench in (a)
puts a fused 32-bit load at 3.28 ns/op):

| window | redundant loads | ceiling on seed4500 (~2,900 ms) |
|---|---|---|
| previous load only | 8.08 M | 32 ms — **1.1%** |
| last 4 | 12.8 M | 51 ms — **1.8%** |
| last 16 | 22.5 M | 90 ms — **3.1%** |

An emit-time within-statement CSE reaches only the syntactically-identical,
call-free subset of that, so the honest expectation is the low end — but the low
end is **1.1%, against (a)'s 0.023%. Sixty times the prize, on the accessors the
profile actually ranks.**

**Verdict: prototype this next, and measure the dynamic coverage of the
rewritten sites the same way (a) was measured, before running any A/B.** The
instrumentation above is the tool: after the rewrite, the count of removed loads
is directly observable as the drop in each accessor's call count.

---

## 5. What else the flamegraph shows

Fresh eyes on the top-25, with stage 1 and stage 2 already banked. Ranked by
expected value, not by size.

### 5.1 Module instantiation is the biggest thing nobody has attacked

`compileSourceTextModule` **229 ms (26.3%) of a short session, 227 ms (5.84%) of
a long one**, plus **~151 ms (17.3%)** of Node's ESM resolution machinery
(`internalModuleStat`, `getPackageScopeConfig` twice over, `JSON.parse` of
`package.json`, `pathToFileURL`, `normalizeString`). Together **44% of a short
session's CPU, and none of it is game work.**

It is paid **per segment**, not per process, and V8's compilation cache does not
rescue the repeats. Four consecutive graph forks in one process, timed:

```
graph 1: harness 17.4 ms   generated (176 modules) 490.1 ms   heapUsed  69 MB
graph 2: harness  1.3 ms   generated (176 modules) 401.2 ms   heapUsed 105 MB
graph 3: harness  1.4 ms   generated (176 modules) 440.5 ms   heapUsed 168 MB
graph 4: harness  1.1 ms   generated (176 modules) 439.5 ms   heapUsed 209 MB
```

The harness collapses to ~1 ms after the first fork — that one *is* cached,
because it is the same URL. The generated graph does not, because
`js/boot/isolation.mjs` gives each segment a distinct `?c2jsseg=N` URL, and a
distinct URL is a distinct script to V8: fresh parse, fresh compile, fresh
bytecode, every time. That query is not gratuitous — it is the only per-segment
freshness a `node --permission` sandbox allows, since the judge forbids child
processes and worker threads. But the price is that **fork 4 costs what fork 1
cost.**

`seed0030-ten-diverse-deaths` is the bill: one session, ten segments, **1,156 MB
of heap and 8.9–10.8 s in a single child, for 1,943 moves** — against seed4500's
1,813 moves in one segment for 2.9–3.6 s. Same move count, three times the time,
and the difference is nine extra parses of the same 13.2 MB.

Two levers, neither previously named in the notes:

1. **Fewer modules.** 176 ES modules means 176 resolutions, 176 `stat` walks,
   176 package-scope lookups and 176 `ModuleWrap`s *per segment*. Merging
   `js/generated/**` into a small number of files (a `yieldify.mjs`-shaped
   post-pass; the graph is cyclic, which is *easier* in one file, not harder,
   since cycles inside a module are just hoisted bindings) removes almost all of
   item 2 and a per-module constant slice of item 1. The work is name
   disambiguation — every C file's statics live in a module scope today and would
   need prefixing — which is mechanical and verifiable by the corpus.
2. **Don't re-parse what is already parsed.** The second segment's graph is
   byte-identical source to the first's, and V8 re-compiles it because the
   `?c2jsseg=N` query makes it a different script. A structure where the graph is
   *instantiated* rather than *parsed* per segment — one parse, N closures —
   would delete item 1 for every segment after the first. That is a bigger
   change than (1) and should be priced after (1) is measured.

**This is the highest-value target in the profile and it is not a `cptr`
problem.**

### 5.2 `ldPtro` — 3.56%, 8.67 M calls, and a million-entry registry behind it

Named in stage 2 as "the largest single accessor"; it still is, and the fresh
numbers sharpen it. 8,669,643 calls on seed4500, and the `__ptrRegistry` those
calls index reaches **1,037,119 entries** in that session. Every load does eight
byte reads, a `(hi - 0x100) * 4294967296 + lo` float multiply, and an array
index. Every *store* of a not-yet-registered pointer allocates a BigInt id and
pushes.

The registry is also the memory story: it is append-only by construction and
strongly retains every `CPtr` it ever held. It is ~8 MB of slots on a long
session, and it is the reason `__releaseSpentGraph()` exists.

Nothing short of stage 3's linear heap removes it, exactly as stage 2 said. But
the arithmetic inside it is cheap to improve and has 8.67 M executions to
amortise over — the id encoding could be chosen so the index is a plain `lo`
when `hi` is the (nearly constant) base, replacing a float multiply-add with a
compare.

### 5.3 `glyphs.js:fill_glyphid_cache` — 41 ms of pure table-building, every segment

New. `initoptions` is 97.9 ms (11.2%) of a short session, and **42% of that is
`initoptions_init → fill_glyphid_cache → parse_id`** — 41.3 ms (4.74%), of which
`parse_id` alone is 32.8 ms (3.75%). This is name-parsing over a static table,
producing a cache, from scratch, on every segment fork. It depends on nothing
the session provides.

It is ~6% of the 691 ms startup intercept, it is self-contained, and it is the
cheapest concrete win on this page. (`initoptions_finish → rcfile →
read_config_file` is another 25.9 ms / 2.97%, and that one *does* depend on the
session's `nethackrc`.)

### 5.4 `harness.mjs:bytesToB64` — 1.13% of a long session, for save persistence

`persistOverlay()` base64-encodes the **whole** VFS overlay every time it runs,
and `save_currentstate` runs on every level change. On seed4500 that is 44.1 ms
(1.13%), and `g.fwrite` above it another 54.4 ms (1.40%). Encoding only the
files that changed since the last persist is a contained change in
contestant-owned code with no parity surface beyond "the overlay round-trips".

### 5.5 `cstr` at 2.09% — up from stage 1's 1.6%

Stage 1's notes flagged `cstr` as one of the honest small targets and measured it
at 1.6%; it is now 2.09% (81.4 ms), partly because `sprintfCore`'s work moved
into it when the format cache landed. It is the third-largest `cptr.js` entry
after `ldPtro` and `add`. It decodes NUL-terminated bytes eight at a time
through `String.fromCharCode`; `TextDecoder` is ruled out (its `latin1` label is
windows-1252 and rewrites 0x80..0x9F). A per-call length probe before the
decode loop, or memoising the literal-backed strings (`lit()` buffers are
immutable and there are only 30,889 of them), are both worth a microbench.

### 5.6 GC at 8.51%, and where the garbage now comes from

Stage 1 and 2 removed 155,111 address allocations from the *source*. GC did not
fall — 8.2% → 7.9% → 8.0% → 8.51%. The remaining producers, in order of count
per seed4500 session:

| source | count |
|---|---|
| BigInts from 64-bit loads | 4,358,682 |
| `{buf, off}` from the 10,372 surviving `cptr.add` sites | (unmeasured; bounded by `add`'s 2.72%) |
| CPtr wrappers from `alloc` + `malloc` | 352,198 |
| strings from `cstr` | (unmeasured; `cstr` is 2.09%) |

(The dynamic redundancy measured in §4(c) says a fifth of *all* loads repeat the
one before them, so a load-CSE also removes a fifth of whatever those loads
allocate — which for `ldPtro` and the 64-bit loads is a heap object each.)

The BigInt count is the striking one and it is *not* addressable by (a): §4(a)
showed only 131 k of those 4.36 M are constant-mask tests. The rest are genuine
64-bit values — `moves`, `u.uprops[*].intrinsic`, timestamps — read into BigInt
because the C type is `long`. **A general "64-bit field read into a JS number
when the emitter can prove the value fits in 2^53" is a larger, separate
question than (a), and the 4.36 M figure is the size of the prize.** It is also
the one change on this page that could plausibly move parity, because it changes
arithmetic representation rather than just a comparison, so it needs its own
design and its own differential fuzz.

### 5.7 What is *not* worth attacking

- **`frozen/screen-decode.mjs` at 3.30%** (`decodeScreen`, `renderCell`,
  `sgrApply`, `observableState`) is the *scorer's* cost, inside `frozen/`. It is
  not ours and it is not in the judge's measurement of us.
- **`add` at 2.72%.** Stage 2's prediction verified. There is nothing left to
  fuse; the 10,372 remaining sites are addresses used as values.
- **Per-buffer tricks.** Stage 2's arena-view census stands: 1,055 distinct
  320-byte buffers carry 29.5% of accessor traffic. Nothing that special-cases
  some buffers reaches that, and every such scheme pays its guard on all of them.

---

## 6. Recommendation

1. **Do not merge (a).** It is committed on `speed-stage3` with its proof and its
   corpus gate so the analysis is not lost, and it is worth 0.023%.
2. **Build (c).** Its dynamic ceiling is already measured — 8.08 M
   immediately-redundant loads per seed4500 session, 1.1% at the strictest
   window, 3.1% at a 16-load window — and its targets are the four hottest
   accessors in the profile. It is the only one of the three candidates that
   clears stage 2's own 3%-on-the-real-corpus bar at its upper end.
3. **Then spend the effort on §5.1.** Module instantiation is 44% of a short
   session and 100% of it is overhead. Nothing else on this page is that large,
   and unlike stage 3's linear heap it does not put parity at risk — the game
   code does not change at all.
4. **§5.3 (`fill_glyphid_cache`, 41 ms/segment) is the cheapest single win** and
   is a good warm-up while §5.1 is being designed.
5. **Fix the measurement rig before the next A/B.** Round 1 of §4(a) was wasted
   on a drifting machine. Every future A/B on this box should be ABBA-ordered,
   should prefer the ~4 s playability runner over the ~70 s corpus runner so N
   can be large, and should report median *and* minimum — when those two
   disagree in sign, as they did here, there is no result.
