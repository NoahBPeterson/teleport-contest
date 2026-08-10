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
