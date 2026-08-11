# Startup — the dead code, and where the module graph's time actually goes

Two pieces of work on one branch (`startup-1`, from `main@b63390a`).

1. **Dead-code suppression**, finishing what the readability leg prepared: the
   generated corpus no longer emits statements nothing can reach. 62 → 0, in
   both trees.
2. **The module-graph startup cost**, which `docs/PROFILE-2026-08.md` §5.1
   named "the biggest thing nobody has attacked" and prescribed *bundling* for.
   Measured, the prescription is wrong in an interesting way: the cost is real
   and it is large, but it is not paid per **module**, it is paid per **import
   statement** — and the corpus has 169 of the first and 4,982 of the second.
   Deduplicating the resolutions costs fifteen lines and buys most of what
   bundling would, without touching a single generated file.

Everything below was measured on this machine (Node v26.5.0, darwin 25.5.0, 10
cores, 16 GB) at `b63390a` and `c3375d8`, load average 3–10 depending on the
hour. Every comparison is an interleaved ABBA A/B reporting **median and
minimum**, per `PROFILE` §6.5's rule; where the two disagree in sign, there is
no result and it is said so.

---

## 1. Dead code — 62 → 0

### 1.1 What it was

Firefox emits `unreachable code after return statement` once per script. It
emitted it for **26 of the generated modules**, and the browser gate for this
project is *zero console output* — the judge fails an entry on any line at all.
V8 says nothing but still parses every one of them.

The scanner (`scratchpad/unreach.mjs`, brace-depth aware, aware of unbraced
control bodies) finds the statements SpiderMonkey warns about: a statement that
follows a terminating sibling in the same statement list.

```
js/generated: 62 unreachable statements in 26 modules
after: [ [ 'return', 61 ], [ 'continue', 1 ] ]
unreachable stmt kind: [ [ '__pc transition', 32 ], [ 'other', 30 ] ]
```

### 1.2 Where it came from — five sources, and only one of them is ours twice over

| suppressed | source |
|---|---|
| 243 | state-machine `__pc = N; continue;` after a case that already returned or gotoed |
| 20 | `break __lbl_X;` closing a synthetic labeled region whose body always transfers control |
| 11 | the tail of an inline-spliced `goto` region |
| 7 | a switch body's tail — **NetHack's own** `default: return; break;` |
| 4 | the same, in an ordinary block |
| **285** | total statements dropped (535 lines, counting the `continue;` each `__pc` carries) |

The counts are *statements suppressed*, not warnings: one warning covers a whole
script, which is why 285 statements were 62 warnings in 26 files.

Four of the five are scaffolding the emitter invents. `smClose()` finishes every
state-machine case with the fall-through transition `__pc = N; continue;`,
because that is how a case says "fall into the next region" — but a case whose
last statement was a `return` has no fall-through to express. Same for the
`break __lbl_X;` that closes a synthetic labeled block, and for the region a
`goto` splices at its call site.

The fifth is NetHack's, and it is worth naming because it is the one case where
the transpiler is faithfully reproducing dead code that a C compiler drops
silently:

```c
    default:
        return; /* can't give it */
        break;                                    /* mon.c:1754-1755 */

    default:
        config_error_add("Unrecognized pet type '%s'.", op);
        return optn_err;
        break;                                    /* options.c:3230-3231 */

            goto makepicks;
            break;                                /* role.c:2711-2712 */
```

### 1.3 The three that took the longest to see

**`earlyarg.c`'s `lopt()`** is the reason the residual sat at 7 after the first
pass. Its three bail labels share one block:

```c
    if (arg[1] != optname[1]) {
    loptbail:
        if (complain) config_error_add("Unknown option: %.60s", origarg);
        return (char *) 0;
    loptnotallowed:
        ...  return (char *) 0;
    loptrequired:
        ...  return (char *) 0;
    }
```

All three are planned `inline`, so every `goto loptbail` splices the region from
that label to the end of the block — i.e. **all three copies**, of which only
the first can run. That accounted for the spliced copies. The *natural* position
took a second look: the label plan for these labels is registered against the
**enclosing** block (`lab.xblock.B`), so the if-body block sees no plan of its
own and its three `return NULL`s arrive at the generic block emitter as plain
siblings. Both paths now run the same dead-run.

**`stmtTerminates()` is an AST predicate, deliberately not a
look-at-the-last-emitted-line test.** `if (c) return 1;` also ends in a `return`
line, and the transition after it is entirely live. The predicate is true only
for `Return`/`Goto`/`IndirectGoto`/`Break`/`Continue` and for a `CompoundStmt`
whose last statement is one of those. `if`/`switch`/loops are *not* included
even when every arm returns: each would need its own exhaustiveness argument,
and nothing this exists to suppress is ever emitted after one.

**The `do`-`while` condition has to be emitted even when it is dropped.**
`condExpr()` interns any string literal it sees, and a file's string table must
not depend on which statements survived — so the line is built and discarded,
not skipped.

### 1.4 The rule, in one place

`emitDeadRun()` is the whole of it. A statement list is straight-line: control
enters at the top and falls from each statement into the next, so once a
statement transfers control away, everything after it is reachable only by a
*jump into* the list. Three things end a dead run:

- **`case` / `default`** — the enclosing switch's dispatch target.
- **a `LabelStmt` whose plan is not an inline splice** — a live `goto` target.
  An `inline`-planned label is not one, because every `goto` to it carries its
  own copy of the region and nothing jumps to the natural position.
- **a declaration.** This is the subtle one. C lets a `goto` jump *past* a
  declaration into code that uses it, and JS has no declared-but-uninitialised
  binding to leave behind — a dropped `let` is a `ReferenceError`, not a garbage
  value. Ending the run at a declaration costs a handful of unreachable
  statements the corpus does not actually contain.

Every item is still **emitted** and only its lines are dropped. Emission interns
string literals, marks helper use and advances the `uniq` counter; skipping it
for some items would make a file's string table depend on which copy of a
spliced region the emitter happened to reach first.

### 1.5 Residual: none, and the proof that nothing else moved

```
js/generated:   0 unreachable statements in 0 modules
js/generated-y: 0 unreachable statements in 0 modules
```

535 lines out of each tree, 33 files, **zero lines added** — the diff is pure
deletion, which is what a dead-code pass should look like.

```
C2JS_DEADCODE=0 C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs --all
git diff --stat origin/main -- js/generated js/generated-y      # (empty)
```

The suppression is a fact of the flag, not a property to be tested for: with the
flag off, the emitter reproduces `origin/main`'s `js/generated` **and**
`js/generated-y` byte-for-byte.

---

## 2. The module graph — what §5.1 got right, and what it got wrong

`PROFILE` §5.1 measured `compileSourceTextModule` at **229 ms (26.3%)** of a
short session plus **~151 ms (17.3%)** of Node's ESM machinery, called it 44% of
a short session's CPU, and prescribed two levers, of which the first was:

> **Fewer modules.** 176 ES modules means 176 resolutions, 176 `stat` walks, 176
> package-scope lookups and 176 `ModuleWrap`s *per segment*.

The 44% is right. The diagnosis inside it is not: the unit is wrong.

### 2.1 The corpus has 169 modules and 4,982 import statements

```
seg 1: resolve calls 4982   distinct (directory, specifier) answers 174
seg 2: resolve calls 4982   new answers 1
```

169 nodes, **4,667 intra-corpus import statements** plus the runtime and
namespace imports — and it is *edges* the loader resolves, not nodes. The
redundancy is 28.6×, and it exists because ESM resolves a relative specifier
against the importer's **directory**: every generated module lives in
`js/generated/`, so `./allmain.js` asked from any of the eighty modules that
import it is one and the same resolution, asked eighty times.

Node's own loader would have cached that. Registering a resolve hook — which
`js/boot/isolation.mjs` must do, because per-segment isolation is what
`?c2jsseg=` buys — takes the loader off that path, so all 4,982 pay in full:
`pathToFileURL`, `normalizeString`, `internalModuleStat`, and
`getPackageScopeConfig` walking up to the repo's `package.json` and `JSON.parse`ing
it. That is precisely the 17.3% bucket, and it is an artefact of the isolation
mechanism rather than of the corpus's shape.

### 2.2 Measuring the two units apart

Three probes, all in `scratchpad/`, all reported median and min:

**(a) Compile is flat in module count.** `probe-compile1.mjs` compiles the real
15.43 MB — module syntax stripped, bodies untouched — as *k* `vm.Script`s, one
cold measurement per process (V8's compilation cache makes any in-process sweep
measure the cache, not the compiler). Six runs per *k*, ABBA:

| chunks | compile ms (median of 6) |
|---|---|
| 169 | 211 |
| 32 | 208 |
| 11 | 213 |
| 6 | 209 |
| 1 | **227** |

**There is no per-module compile constant worth having**, and one 15 MB script
is *slower* than 169 small ones. The 229 ms is per-byte, and bundling does not
reduce bytes.

**(b) Per module, the loader charges ~0.11 ms; per import statement, ~0.03 ms.**
`probe-esm2.mjs` lays the real generated sources out two ways under the real
resolve hook — one file per module carrying its **real** edge set, versus the
identical bytes in *k* byte-balanced files — and imports each under a fresh
`?c2jsseg=` tag. An earlier version of this probe used a star topology (169
edges instead of 4,667) and reported a 20 ms saving; that number was wrong, and
it is the reason the first conclusion drawn here was "bundling is not worth it".
Getting the edges right changed the answer by 6×.

**(c) The scoring path's real graph.** `probe-graph3.mjs` imports
`js/generated/unixmain.js` under three successive segment tags. It must `await
enableSegmentIsolation()` — the function is async, and without the await
segment 1 resolves before the hook exists and silently loads the *shared*
graph, which is both wrong and much cheaper. That bug cost an hour.

### 2.3 The fix: memoise the hook's own resolutions

Fifteen lines in `js/boot/isolation.mjs`. Key on
`(parent directory, specifier, conditions, import attributes)`; cache the
**untagged** result and take the `?c2jsseg=` tag from the live parent, so a
cache hit still forks per segment exactly as before.

It cannot change what is resolved. The URL is `new URL(specifier, parentURL)`,
and the `format` Node reports follows from that URL's extension and the nearest
`package.json` `type` — both fixed once directory and specifier are. The only
thing that could move a cached answer is the filesystem changing underfoot
mid-run, which this program does not do: the VFS overlay is in memory, and the
scored path runs under `node --permission` with no write allowance at all.

`C2JS_RESOLVE_CACHE=0` restores the uncached hook, which is the A/B baseline.

**Graph instantiation, interleaved ABBA ×5, per segment, median (min):**

| segment | hook as it was | memoised | saved |
|---|---|---|---|
| 1 | 400.7 (393.8) | 300.8 (295.5) | **99.9 (98.3)** |
| 2 | 380.9 (371.6) | 289.1 (282.6) | **91.8 (89.0)** |
| 3 | 387.4 (372.7) | 291.1 (284.7) | **96.3 (88.0)** |

Median and minimum agree in sign and in magnitude, on every segment.

### 2.4 …which is most of what bundling was for

`probe-esm2.mjs`, same bytes, same real edges, run twice — once with the memo
and once without. Six ABBA reps, median (min) ms:

| modules | hook as it was | memoised |
|---|---|---|
| 169 (as shipped) | 340.7 (338.3) | 277.0 (272.7) |
| 44 | 222.7 (217.6) | 223.9 (220.8) |
| 12 | 212.0 (209.3) | 215.5 (213.5) |
| 6 | 215.0 (206.8) | 218.8 (212.4) |
| 1 | 222.6 (214.8) | 228.6 (222.3) |

Read the two columns against each other:

- Bundling **without** the memo would have been worth **129 ms** (169 → 12).
- The memo alone is worth **64 ms** of that (340.7 → 277.0) and costs nothing.
- Bundling **after** the memo is worth **61 ms** more (277.0 → 215.5).
- And the two bottom rows say the same thing every time: **one bundle is the
  worst of the bundled options.** 169 → 44 captures 53 of the 61 ms; 44 → 12 →
  6 → 1 is flat inside noise, and 1 is measurably *worse* than 6 or 12, exactly
  as the compile sweep in (a) predicted.

### 2.5 Granularity decision: **do not bundle. 169 modules, unchanged.**

Decided from the table above, not from taste.

The residual prize after the memo is ~50–61 ms per graph, and in a synthetic
that flatters it (side-effect-only imports; no name disambiguation to pay for).
Against it:

- **39,901 top-level declarations** would need alpha-renaming — 24,163 `__slN`
  string-table consts whose numbering restarts at 0 in every file (`__sl0`
  exists in 167 modules), 13,412 `$field` fold consts of which 1,719 names are
  duplicated across files, and 247 genuine C-symbol collisions including `panic`
  ×3, `main` ×3, and `MCMD_*`/`MB_INDEX_*`/`jAny…jDiag` shared between
  `cmd.js`/`artifact.js`/`apply.js` and `nhconst.js`. 211 of the collisions are
  on *exported* names, so a re-export barrel is illegal too.
- **`tools/c2js/callgraph.mjs` node ids are `"<module>#<function>"`** and the
  comment says why: "C's one-definition rule makes most names unique but
  file-static functions collide, so the module qualifier is load-bearing". One
  scope makes the yield build's call colouring ambiguous — the most dangerous
  consequence on the list, because it is silent.
- **`tools/c2js/resetify.mjs`'s barrel is per-module by construction** — 146
  `__captureState`/`__resetState` pairs plus an evaluation-order import list
  whose order fixes every pointer id in `cptr`'s registry.
- **19 static imports in `js/lua-js/{bridge,registry,readback,interp-state}.mjs`**
  name 13 generated modules directly, and `tools/c2js/test-rnd.mjs` relies on
  `rnd.js?s=N` giving it a fresh single module per case.
- And it would take the per-file readability the previous leg just bought and
  put it through a mangler. Standing order is parity > speed > readability, but
  61 ms is not a speed argument that outranks all of that.

The one honest version of the change — group the corpus into ~44 bundles along
evaluation order, where the knee is — buys ~53 ms and still pays every one of
the costs above. It is not worth it, and the measurement says so before the
taste does.

**What §5.1 should say instead:** the 17.3% ESM bucket is real, it is bigger
than the "176 resolutions" framing suggests (4,982, not 176), and it is
removable *without* touching the corpus, because it is redundancy in the hook
rather than shape in the graph. Lever 2 of §5.1 — "don't re-parse what is
already parsed" — is untouched by this work and remains the larger remaining
item.

### 2.6 What it is worth on the scoring path

`frozen/ps_test_runner.mjs sessions/` (44 sessions, 9,096 moves), interleaved
ABBA, five pairs, `C2JS_RESOLVE_CACHE=0` against `=1`. `startup_ms` and
`per_move_ms` are the runner's own OLS fit — the numbers the judge's shape is
quoted in.

| | `startup_ms` median (min) | `per_move_ms` median (min) | passing |
|---|---|---|---|
| hook as it was | 837.8 (817.7) | 1.2560 (1.2222) | 44/44 ×5 |
| memoised | **754.6 (725.6)** | 1.2363 (1.2189) | 44/44 ×5 |
| delta | **−83.2 (−92.1) ms, −9.9%** | −0.0197 (−0.0033) | |

Median and minimum agree in sign on both terms. The slope is the control and it
behaves like one: the memo runs once per module graph and never during a move,
so the only honest reading of −0.02 ms is *nothing, within the noise of a box
whose load average was 9–18 for the whole run*. Startup is the term that moved,
and it moved by what §2.3's per-graph measurement predicted (the scored path
forks **one** graph per process and resets it between segments, so a session
pays graph instantiation once and the saving lands whole in the intercept).

The raw runs, because the range matters more than the median on a contended box:

```
off  817.7  837.8  820.2  877.9  1047.0
on   725.6  758.7  731.5  754.6   850.8
```

Every `on` run is below every `off` run except the two contaminated tails, which
are paired (round 5 was slow on both sides).

---

## 3. What the readability leg's bytes actually cost, re-priced

`docs/NOTES-readability.md` recorded the tree growing **13.36 → 15.98 MB
(+19.5%)** and local startup going 833–864 → 892–971 ms. §2.2(a) above says
compile is per-byte at ~13.7 ms/MB, so the prediction is ~36 ms — and that is a
thing that can be measured directly rather than inferred from two startup
figures taken an hour apart.

Both trees, instantiated under the same (memoised) hook, in the same minute,
interleaved ABBA ×8:

| tree | files | bytes | instantiation median (min) |
|---|---|---|---|
| `b63390a^1` — before readability | 177 | 13,363,515 | 315.6 (291.5) ms |
| `HEAD` — after readability + dead code | 179 | 15,965,231 | 351.0 (334.2) ms |
| | | **+19.5%** | **+35.4 (+42.7) ms** |

So the vocabulary tier costs **35–43 ms of graph instantiation**, median and
minimum agreeing, and matching the per-byte model to within a millisecond.

**The net for this branch: readability costs 35–43 ms; the resolve memo returns
83–92 ms.** The tree is both more readable than it was before that leg *and*
faster than it was before that leg — by roughly 40–50 ms — and the dead-code
pass took a further 10.5 KB (−0.07%) off the bytes on the way through.

That also settles the question the readability leg left open. Its +19.5% was
never worth undoing at 36 ms; it is worth even less now, because the thing it
was being weighed against turned out to be an artefact of the isolation hook
rather than a property of the corpus.

---

## 4. Gates

| gate | result |
|---|---|
| unreachable statements, both trees | **62 → 0** |
| `C2JS_FOLD_VERIFY` | 301,692 folds, **0 mismatched, 0 unevaluable** |
| full rebuild reproduces committed trees | sync + yield + reset barrels, byte-for-byte |
| flags-off rebuild (`C2JS_DEADCODE=0`) | reproduces `origin/main` byte-for-byte |
| corpus, reset scoring path, Lua ports live | **69/69 twice** (898+0.55, 931+0.57) |
| `reset-diff --via runsegment` | **12/12**; `--force-noop` **0/12** as it must |
| `reset-census` | 178 modules, plan 1,416, **0 unclassified**; `js/lua-js` 46 signed, 0 unclassified |
| `node --test` | **6/6** |
| c2js parity drivers | test-rnd, test-hacklib (870 cases), test-setjmp, test-union — all PASS |
| `strict-score` | 507 files / 2 roots, **0 violations**, 3-session sandbox parity |

---

## 5. What is left, in order

1. **§5.1 lever 2 — "don't re-parse what is already parsed."** Untouched, and
   now the largest remaining item in graph instantiation: ~211 ms of the
   remaining ~300 is V8 compiling 15.4 MB, and the scored path compiles it once
   per process. A structure where the graph is *instantiated* rather than
   *parsed* per segment would delete it for every segment after the first. The
   reset realm already gets most of this benefit for free — it forks one graph
   and resets it — so the prize is narrower than §5.1 assumed and belongs to the
   fork fallback path.
2. **`PROFILE` §5.3 — `fill_glyphid_cache`, 41 ms per segment** of pure table
   building that depends on nothing the session provides. Still the cheapest
   single win on the page and still unclaimed; this leg deliberately did not
   take it, to keep one change under one set of gates.
3. **Bundling** stays refused, at 169 modules, on the measurement in §2.4–2.5
   rather than on principle. If the compile term in (1) is ever attacked and the
   remaining per-module ~50 ms becomes the largest thing left, the table in §2.4
   says where to start: ~44 groups along evaluation order, not one file.

---

# Part two — the network (branch `net-startup`, from `main@826e136`)

Everything above measures **parse** and **instantiation**, on **loopback**. It
is all correct and none of it is the reason a player waits. On the real mirror
the module graph's cost is not what V8 does with it; it is what the *edge*
charges for handing it over, and that term does not appear in a single
measurement in Part one.

§2.5 refused bundling on a 61 ms parse argument. That refusal is now overturned
by a measurement it never took — but not for any of the reasons §2.5 weighed,
and the corrected number is thirty times larger.

Every figure below is from headless Chrome driven over CDP against
**`https://mazesofmenace.ai/play/NoahBPeterson/` — the judge's own play page on
the live mirror**, or against `tools/judge-sim/server.mjs` calibrated to it. The
judge's page is the one that matters: our `index.html` is not what the mirror
serves at `/play/<owner>/`, and the two pages take different rungs.

## 6. What the mirror actually does

### 6.1 The shape of a judged page load

Three runs, cold profile, page target, median (min–max):

| | before this branch |
|---|---|
| navigation → "press any key" painted | 1490 ms (1476–1533) |
| gate key → first game frame | **3734 ms** (3663–6074) |
| navigation → first game frame | **5313 ms** (5176–8322) |

The judge's playability report has been coming back at ~3.1–3.2 s total with
**0 moves, every crawl**. 5.3 s against ~3.2 s of patience is not a slow page;
it is a page that never gets to play.

### 6.2 Where the 3.7 s goes: a dead window, and a second engine

Two things, and neither is compute.

**(a) Nothing downloads for the first 1.5–3.2 s after the gate key.** The first
byte of `js/generated-y/**` is asked for at 3.0–3.2 s of a run whose gate was at
1.5 s. In between, the page is walking a chain of round trips at ~320 ms each —
`navigator.serviceWorker.register()`, a dedicated worker realm's own three
modules, a `SharedWorker` realm's, one synchronous interception probe per realm
— and then sitting out `FALLBACK_HEAD_START_MS`, a 700 ms constant measured on
loopback where those same round trips cost about five milliseconds in total.

**(b) Both engine trees are fetched.** A page-target census counts 202 requests;
a census that attaches to *every* target — a dedicated worker is its own target
and its requests never appear on the page's Network domain, which is why this
was invisible for so long — counts:

```
399 requests, 6375 KB
  js/generated-y/   170 files   2734 KB     (the main-thread fallback rung)
  js/generated/     169 files   2668 KB     (the transport rung, in its worker)
  js/data-nethackdir/ 12 files   690 KB
  js/ (other)        31 files   147 KB
  js/lua-js/          9 files    29 KB
```

The fallback wins the race and paints from `js/generated-y/`; the transport
comes up a second later and pulls `js/generated/` **concurrently with it**, onto
the same link, for a game it is not going to paint. The page needs one tree and
downloads two.

### 6.3 The measurement that overturns §2.5: request count is not free

§2.4 priced a module at ~0.11 ms of Node loader work and 0 ms of compile, and
concluded that 169 modules cost about the same as one. On loopback that is true.
On the mirror it is not remotely true, and the control is trivial to run: fetch
**180 cache-busted copies of a 1.9 KB file** — 50 KB on the wire, nothing to
download — and time it against fetching the 180 real modules.

`fetch()` only, no parse, no execute, warm (the first fetch of anything on this
mirror is a CDN miss and is not comparable):

| what | requests | wire | ms |
|---|---|---|---|
| 40 × a 1.9 KB file, cache-busted | 40 | ~11 KB | 399 |
| 180 × a 1.9 KB file, cache-busted | 180 | ~50 KB | **2889 / 2099 / 2445** |
| 180 × the real `js/generated-y/**` | 180 | 2.7 MB | 6952 / 3637 / 9606 |
| 5 × `js/data-nethackdir/chunk-*` | 5 | ~690 KB | 1866 |

**The edge charges ~12–16 ms of serialized work per request, whatever the
request is.** 180 requests is a **2.1–2.9 second floor** before one byte of
engine has been counted, and it scales linearly (40 requests → 399 ms).

That is the number §2.5 should have been weighed against. It is not 61 ms of
V8; it is two seconds of somebody else's CDN, on the one budget the judge
measures — and unlike the parse term it does not shrink when the machine is
fast, because it is not our machine.

**So: §2.5's verdict is wrong, and §2.4's table is not the table to read.** It
measured the right thing (parse, instantiation) on the wrong link (loopback) and
therefore answered a question nobody was asking. Bundling is worth roughly two
seconds on the judged path, which is most of the gap between 5.3 s and 3.2 s.

### 6.4 Why no loopback profile could have found this

`tools/judge-sim/server.mjs` was, until this branch, a plain `node:http` server
answering out of the page cache in microseconds. Three of its properties are the
mirror's opposites, and each one hides a different term:

| | the stand-in | the mirror | what it hid |
|---|---|---|---|
| compression | none | gzip | the tree priced at 16 MB, not the 2.7 MB on the wire |
| protocol | HTTP/1.1 | HTTP/2 | Chrome caps an h1 origin at six connections, so an h1 stand-in **over**charges request count ~70× — wrong in the other direction, and just as useless |
| per-request cost | ~0 | 12–16 ms | §6.3 entirely |
| link rate | ∞ | ~1–3 MB/s | every byte-count argument |

It now has all four as opt-in switches — `--gzip`, `--h2`, `--bw=`/`--bw-lanes=`,
`--req-cost=` — all defaulting off so every existing gate sees the server it
always saw. With `--their-page --gzip --h2 --latency=115 --bw=3200000` the
stand-in reproduces the mirror's before-numbers to within 4 % on
navigation→first-frame (4954–5165 ms against the mirror's 5176–5313 ms) and
lands the engine tree's first request within 0.2 s of where the mirror lands it.
That calibration is what the A/B below is run on.

`--req-cost` is deliberately *not* in that calibration. It models the origin as
one FIFO server, which queues the page's own load behind the engine's in a way
the mirror's many-core edge does not; it is an upper bound on the request-count
term, not a calibration of it. The number that matters — §6.3 — was measured on
the mirror directly and needs no model at all.

## 7. What this branch changed

### 7.1 Spend the gate window (`js/boot/preload.mjs`)

The judge's page imports `js/jsmain.js` at parse time and then waits at
`await display.readKey()`. That is a second or more of link with nothing on it,
and `preloadEngine()`, called at `jsmain.js` module scope, spends it: four
`<link rel="modulepreload">` elements covering the fallback rung's boot chain
and the reset barrel, which statically imports all 180 modules of the tree.

`modulepreload` and not `import()`, deliberately. A preload fetches and compiles
without *evaluating*, so it does not spend the one page realm the main-thread
rung is allowed to own on a game nobody has asked for; whoever imports the tree
later gets a module-map hit and pays no network. If nobody ever does, nothing
was spent but bandwidth.

It is armed only when a round trip is expensive — `SLOW_LINK_RTT_MS = 25`, asked
of the document's own navigation timing — and never on our own `index.html`,
which arms a real prewarm in its `<head>` and will want the *other* tree.

### 7.2 Stop fetching the second tree (`js/boot/interactive.mjs`)

Two rules, both conditioned on the same signal, both no-ops on a fast link and
on a page that armed a prewarm before the race began:

- **`fallbackHeadStartMs()`** returns 0 instead of 700 when a round trip is
  expensive. The head start exists to keep two boots off the same CPU; on a
  slow link the contended resource is the link, the transport is four round
  trips behind before it starts, and the 700 ms is time in which nothing at all
  is downloading.
- **The transport yields its boot to the fallback's first frame.** `_boot()` is
  what makes the transport's realm pull `js/generated/**`. A transport that
  cannot paint first now waits for the fallback to paint, then boots and
  upgrades through the swap that was already there. The player gets the fast
  first frame *and* the fast engine, in that order, instead of both of them
  late.

Neither rule can strand a game: the wait ends on the fallback painting **or**
failing, and is capped at `TRANSPORT_YIELD_CAP_MS` for a fallback that does
neither.

### 7.3 Measured

**The stand-in, calibrated** (`--their-page --gzip --h2 --latency=115
--bw=3200000`), judge's play page, **interleaved ABBA, four runs a side**, the
two revisions checked in and out under one server:

| | before (`826e136`) | after |
|---|---|---|
| gate → first frame | 3899 / 3863 / 3863 ms | **2301 / 2335 / 2317 / 2293 ms** |
| navigation → first frame | 4791 / 4812 / 4812 ms | **3255 / 3292 / 3260 / 3310 ms** |
| engine tree's first request at | 3.19 / 3.12 / 3.11 / 3.19 s | **0.94 / 0.94 / 0.92 / 1.00 s** |
| console entries | 0 | 0 |

Median and minimum agree in sign and magnitude on every line: **−40 % on
gate→first-frame, −32 % on navigation→first-frame**, and the tree starts
downloading 2.2 s earlier. The after column's spread is 17 ms across four runs,
which is what a change that removes a wait rather than a computation looks like.

(One `before` run in the fourth pair painted nothing and logged 19 console
entries. It is on `826e136`'s code, under a contended box; it is recorded rather
than dropped, and it is not counted in the medians above.)

**Census** on the same stand-in, all realms attached:

| | before | after |
|---|---|---|
| requests | 399 | **214** |
| bytes | 6375 KB | **3576 KB** |

**The live mirror.** The after-state cannot be published — nothing on this
branch is pushed — so it is measured by serving *only the three files this
branch touched* (`js/jsmain.js`, `js/boot/interactive.mjs`,
`js/boot/preload.mjs`) from disk through CDP request interception, with the
engine tree, the CDN, the round trips and the edge's per-request cost all still
the mirror's. Interception is switched off the moment the third file is served,
so it is not on the clock of the thing being timed.

The link was badly degraded during this window — the `before` arm, which had
measured 5176–5313 ms of navigation→first-frame earlier the same day, measured
11.7–32.8 s — so the absolute numbers are not comparable to §6.1. The paired
comparison is, and the term this branch attacks is visible in it directly:

| run | engine tree's first request at |
|---|---|
| before | 15.23 s / 12.14 s / 9.33 s |
| after | **2.59 s / 6.26 s / 1.35 s** |

The tree starts downloading between 3 s and 12 s earlier on every pair, which is
the same effect the stand-in measures at 2.2 s under a link that is behaving.

## 8. Bundling — the verdict, corrected, and the design it implies

§2.5 said "do not bundle, 169 modules, unchanged", and §5 item 3 said the prize
was ~50 ms. On the network the prize is **~2 s** (§6.3), and the reasoning that
refused it — 39,901 declarations to alpha-rename, a call graph keyed on
`<module>#<function>`, per-module reset barrels, 19 external import sites — is
a list of costs, not a counter-measurement. Weighed against 61 ms those costs
win. Weighed against two seconds on a budget we are currently missing by two
seconds, they do not.

**This branch does not land it.** What it lands is the measurement that says it
must be landed, the two changes that were separable from it, and the simulator
that can now price it. The design the measurement implies, so the next leg does
not have to re-derive it:

1. **Scope: `js/generated-y/` first, and it is self-contained.** The only
   consumers outside the tree are `js/boot/harness-y.mjs` (`unixmain.js`,
   `rnd.js`), `js/boot/reset-realm.mjs` (`__reset.js`) and
   `js/boot/main-thread-engine.mjs` (`rnd.js`) — four call sites. In
   particular **`js/lua-js/**` does not touch it**: all 19 of its static imports
   name `../generated/`, the *sync* tree, even in the yieldable build. The
   hazard §2.5 listed as fifth on its list does not exist on this half.
2. **A build-time pass, not a text stitcher** — `tools/c2js/bundle.mjs`, run
   from `build.mjs` after `assertTreesHygienic` so the four read-back-driven
   sidecar writers, `assertNamespaceExports` and the hygiene assert all still
   scan the unbundled tree, and gated on `C2JS_BUNDLE` in the shape of
   `maybeYield`/`maybeReset`. Never written into `js/generated-y/` before
   `yieldify.mjs` runs: that pass `rm -rf`s the directory.
3. **An additional artifact, not a replacement.** The per-module tree stays
   exactly as it is — readable, diffable, and what `callgraph.mjs`,
   `resetify.mjs`, `reset-census.mjs` and `yieldify.mjs` read. The bundle is a
   derived deployment artifact the browser's fallback rung loads instead.
4. **Order is the load-bearing part.** Concatenate in ESM evaluation order —
   DFS post-order from `unixmain.js`, then the barrel's remainder — because
   that order fixes every `cptr` pointer id and therefore RNG parity, which is
   the same reason `resetify.mjs:189-194` imports the entry bare and first.
5. **Keep `nhconst.js`, `nhmacro.js`, `nhfield.js` outside it.** They are
   import-free leaves read only as `NHC.x` / `NHM.x` / `FLD.x` namespaces, so
   leaving them as three real modules preserves that idiom byte-for-byte and
   costs three requests. `nhprop.js` and `nhmacrofn.js` must go *inside* — they
   import `decl.js`, `sys.js`, `artifact.js` and `cmd.js` and are part of the
   cycle. `js/cptr.js` stays outside and shared, as the reset registry requires.
6. **Renaming, cheapest first.** Of 40,094 top-level declarations, 24,163 are
   per-file `__slN` string-table consts and 13,412 are `$field` fold consts.
   The `$field` consts are `const $x = FLD.x` — *identical in every module* — so
   they collapse to one deduplicated block at bundle scope and 13,412
   declarations and their 1,719 duplicate names disappear. `__slN` names carry
   an unshadowable prefix and are renamed mechanically. That leaves ~2,500 real
   C symbols with ~247 collisions, of which 213 are on exported names — a small
   enough set to rename by an auditable rule (earliest in evaluation order keeps
   the bare name) with a build-time assertion that the new name occurs nowhere
   else in the module.
7. **Granularity: few, not one, and measure.** §2.4's answer (44 groups) was
   about parse and does not apply. The network answer is that per-request cost
   is ~12–16 ms and falls to nothing by ~8 files, while a single 2.7 MB response
   is the one shape whose throughput depends on a stream ramping up. Four to
   eight chunks along evaluation order captures essentially all of the ~2 s and
   keeps several streams in flight; `--bw-lanes` exists in the stand-in
   specifically so that question can be asked without a modelling artefact
   answering it. Measure 1 / 4 / 8 / 16 and take the knee.

## 9. What is left, in order (superseding §5)

1. **Bundle `js/generated-y/`** per §8. ~2 s on the judged path; the largest
   single item on the page by a factor of ten.
2. **Bundle `js/generated/`** the same way, once the first is gated. It is not
   on the first-frame path any more (§7.2 moved it behind the frame) but it is
   on the *upgrade* path and on our own page's.
3. §5's items 1 and 2 — the compile term and `fill_glyphid_cache` — are
   unchanged and remain what they were: real, local, and an order of magnitude
   smaller than anything in Part two.
