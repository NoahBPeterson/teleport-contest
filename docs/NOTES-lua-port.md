# Lua → JS script port (roadmap 1.10)

NetHack ships its special levels, dungeon layout, quest text and themed rooms as
131 `.lua` scripts, executed by a Lua 5.4.8 interpreter that this fork transpiles
along with the rest of the C. Roadmap 1.10 ports those scripts to readable
JavaScript under `js/`, keeping the transpiled interpreter in the tree as a
**differential oracle**: for every ported script we can run both and prove them
equivalent.

This note is the architecture decision, the traps analysis, the proof-of-concept
result, the cookbook for porting script #2, and the staged plan for the rest.

Status: **PoC landed.** `oracle.lua` is ported and live; the corpus passes with
the port enabled and with it disabled.

---

## 1. Inventory

131 files, 640 KB of Lua, vendored into `js/data-nethackdir/chunk-*.mjs` by
`tools/vendor-data.mjs` (sources readable at `nethack-c/recorder/dat/*.lua`).

### Where the C side loads each

Everything enters the VM through **one** function, `nhl_loadlua()`
(`nethack-c/recorder/src/nhlua.c:2338` → `js/generated/nhlua.js:2178`):

```
fopen(fname,"r") → fseek/ftell/fread/fclose → luaL_loadbufferx → nhl_pcall_handle
```

| Caller | Script | Lifetime of the lua_State |
|---|---|---|
| `l_nhcore_init()` (nhlua.c:148) | `nhcore.lua` | whole game (`gl.luacore`) |
| `nhl_init()` (nhlua.c:2511) | `nhlib.lua` | **every** state gets it at creation |
| `init_dungeons()` (dungeon.c:1221) | `dungeon.lua` | one-shot |
| `makerooms()` (mklev.c:377) | `themerms.lua` | cached per dungeon branch (`gl.luathemes[dnum]`) |
| `com_pager()` (questpgr.c:494) | `quest.lua` | fresh state per lookup |
| `makemaz()` → `load_special()` → `load_lua()` (mkmaze.c:1188, sp_lev.c:6461) | every level script | throwaway state per level |
| `wiz_load_lua` / `wiz_load_splua` (wizcmds.c) | user-named | wizard mode only |

The throwaway-per-level lifetime is what makes level scripts the easy tier: no
Lua state survives them.

### API surface

29 `des.*` + 24 `selection.*` methods + 15 `obj.*` + 41 `nh.*` = the whole
contract. Registered by `l_register_des()` (sp_lev.c:6433, 34 entries),
`l_selection_register()` (nhlsel.c:981), `l_obj_register()` (nhlobj.c:629) and
`nhl_functions[]` (nhlua.c:2002).

Ten `des` calls cover 90 % of all 6,577 uses:

| call | uses | files | | call | uses | files |
|---|---|---|---|---|---|---|
| `des.monster` | 2111 | 119 | | `des.stair` | 172 | 107 |
| `des.object` | 1420 | 118 | | `des.room` | 171 | 16 |
| `des.trap` | 794 | 117 | | `des.level_init` | 152 | 111 |
| `des.door` | 603 | 63 | | `des.map` | 126 | 95 |
| `des.region` | 364 | 87 | | `des.level_flags` | 118 | 112 |

`selection.area` (356 uses / 89 files) dominates the selection side;
`percent()` (145 / 30) and `shuffle()` (25 / 12) dominate the nhlib helpers.

### Difficulty tiers

Mechanical classification (comments stripped; score = functions + if + for +
while + percent + shuffle + math.random + nh.rn2):

| Tier | Files | What |
|---|---|---|
| **T0** pure declarative, no control flow, no RNG | 51 | `quest.lua` (132 KB of prose, zero code), `dungeon.lua` (pure data), the quest `*-goal/-loca/-fil*` levels, `soko*`, `air/fire/water/earth`, `baalz`, `tower3`, `tut-2` |
| **T1** declarative + a little RNG or one closure | 18 | `castle` (8.6 KB, two shuffles), `juiblex`, `sanctum`, the `*-strt` quest homes, `minend-1/3`, `fakewiz1/2`, `wizard2` |
| **T2** loops / conditionals / closures | 58 | `minetn-*`, `medusa-*`, `bigrm-*`, `astral`, `knox`, `valley`, `orcus`, `oracle`, `tut-1`, `Wiz-loca`, the 10 `*-fil{a,b}` closure levels |
| **T3** heavy logic | 4 | `themerms.lua` (34 KB, 87 functions, reservoir sampling), `hellfill.lua` (12 KB), `nhlib.lua` (7 KB, the shared prelude), `nhcore.lua` (4.8 KB, the callback registry) |

By bytes the corpus is far easier than the file count suggests: `quest.lua` +
`dungeon.lua` alone are 21.7 % of it and contain **no executable statements**.

### Lua language features actually used

Almost none. Across all 131 files there are **zero** occurrences of
`setmetatable`, `coroutine`, `pcall`, `require`/`dofile`/`load`, `goto`, `os.*`,
integer bitwise operators, `table.remove/sort/concat`, `gsub`/`gmatch`/`find`.
There is exactly one `error()` (nhlib.lua:13), one `io.open` (nhcore.lua:63, in a
function that is commented out of the dispatch table), two `string:match` calls
(tut-1.lua:7,13), one integer division (bigrm-13.lua:53), three
`string.format`, three `table.insert`, four varargs sites.

What *is* used: numeric `for`, `if/elseif`, `repeat/until` (two sites), table
constructors, anonymous closures (326 `function` tokens, 284 of them anonymous
`contents = function() … end`), and `..` for string joining.

---

## 2. Architecture decision

**Chosen: Candidate A′ — ported scripts drive the transpiled Lua C API through a
port-owned `lua_State`.**

The decisive observation is that *a level script cannot see Lua*. Everything it
does leaves through a C function registered into the state — `des.*`,
`selection.*`, `obj.*`, `nh.*` — and every one of those reads its arguments off
the Lua stack and then mutates NetHack's C globals: the level map, the object and
monster chains, the RNG. Nothing in the game reads back a Lua value that a script
produced. The `lua_State` is a *marshalling buffer*, not a semantic participant.

So a port needs no source, no parser and no VM. It needs to build the same
argument values and call the same C functions in the same order. `js/lua-js/`
does exactly that: `lua_createtable` / `lua_pushstring` / `lua_setfield` /
`lua_callk` — precisely the calls the VM's `OP_NEWTABLE` / `OP_SETFIELD` /
`OP_CALL` would have made — against the real, unmodified, transpiled `lspo_*`
implementations. They cannot tell the difference because there is none.

The `′` on Candidate A is that the port uses **its own** `lua_State` rather than
the interpreter's. The one nhl_loadlua is holding is a local variable buried in
transpiled C; ES module bindings are immutable and two of its three call sites
are intra-module (`nhlua.js:2281`, `:2318`), so it is unreachable from harness JS
without hand-editing `js/generated` (forbidden) or an emitter hook (out of
scope). It is also unnecessary: the C bindings key off NetHack's globals, not off
which state invoked them, so `luaL_newstate()` plus the same three registrations
(`l_selection_register`, `l_register_des`, `l_obj_register`) is sufficient. The
port state is created once per module graph — once per replay segment — and
reused. It is deliberately **not** built with `nhl_init()`, because `nhl_init`
also loads `nhlib.lua`, whose top-level `shuffle(align)` spends two `rn2()`
draws; those belong to the interpreter's own per-script `nhl_init()`, which still
runs untouched, and duplicating them would desynchronise the RNG immediately.

Candidate B (reimplement the nhl binding surface in JS and bypass `lua_State`
entirely) was rejected: `lspo_object` alone is 200 lines of transpiled C reading
19 fields with type coercions, defaults and `"random"` sentinels, and there are
34 of them plus 24 selection methods. Hand-porting that is thousands of lines of
new C-equivalent logic with no oracle stronger than the corpus, in exchange for
runtime speed the project does not need (level generation is a rounding error
next to the move loop). The Lua stack costs a few hundred pushes per level.
Candidate A′ ports the *scripts*, which is what the mandate asks for, and leaves
the *engine* transpiled, which is what makes parity provable.

One JS-specific fact makes A′ nearly free: in this transpile a C function pointer
**is** a JS function object (`js/generated/ldo.js:504` calls it as `n = (f)(L)`),
so `lua_pushcclosure(L, jsClosure, 0)` makes a JS arrow function a valid
`lua_CFunction`. That is how `contents = function() … end` ports: `lspo_room()`
pushes the mkroom table and calls it through `nhl_pcall_handle()` exactly as it
calls a Lua closure, so the recursion back into the script body happens at the
same point in the same order.

---

## 3. The correctness traps, analysed

### (a) Lua table traversal order

**Not a hazard on the level-generation path.** `lua_next` appears exactly twice
in the whole non-Lua C source, and neither is in `sp_lev.c`:

* `dungeon.c:1278` — walks the `dungeon` global, which is array-like, so the
  traversal runs the array part in ascending index order.
* `nhlua.c:752` — `nh.menu()`, not reachable during level generation.

Every `lspo_*` reads its fields **by name** with `lua_getfield`, in an order
hard-coded into the C function body (`get_table_int_opt`, `get_table_option`,
`get_table_boolean_opt`, `get_table_mapchr`, …). Field order inside a table
constructor is therefore unobservable; what matters is the C-side read order,
which is fixed. Positional reads (`region = {x1,y1,x2,y2}`, `coord = {x,y}`) go
through `get_table_intarray_entry`, i.e. integer indices — also deterministic.

The bridge nevertheless preserves JS object key order and passes matching
`narr`/`nrec` size hints to `lua_createtable`, so the internal hash layout of a
marshalled table is the one the parser would have built. That costs nothing and
removes the trap entirely rather than relying on the argument above.

On the Lua-source side there are only four `pairs`/`ipairs` sites in all 131
files: `nhcore.lua:48` (callback dispatch), `nhlib.lua:159` (`table_stringify`),
`nhlib.lua:233` (`tutorial_events`) and `themerms.lua:1093` (`ipairs`, ordered).
The three `pairs` ones are hash-order-dependent and all live in the two library
files — a real constraint for T3, none for level scripts. `themerms.lua`'s hot
path iterates numerically and is fully deterministic.

Note that the VM's string-hash seed *is* environment-derived —
`luai_makeseed()` (`js/generated/lstate.js:34`) mixes `time(NULL)` with pointer
values — so hash order is only reproducible because the harness pins `time()`
and the `cptr` allocator is deterministic. Any port of `nhcore.lua` or
`nhlib.lua`'s `table_stringify` must reproduce the *observed* order, not assume
one.

### (b) `nh.rn2` call order

All script-visible randomness is NetHack's own RNG. `nhl_rn2` is a bare
`rn2(range)`; `nhl_random` is `rn2(range)` or `base + rn2(range)`
(`js/generated/nhlua.js:1142`,`:1154`). `nhlib.lua` replaces `math.random`
wholesale with a shim over those, so *every* `math.random` in every script is a
NetHack draw. The bridge reproduces the shim exactly:

| Lua | draws |
|---|---|
| `math.random(n)` | `1 + rn2(n)` |
| `math.random(lo,hi)` | `lo + rn2(hi + 1 - lo)` |
| `percent(t)` | `rn2(100) < t` |
| `shuffle(list)` | descending Fisher–Yates, `1 + rn2(i)` for `i = #list … 2` |
| `d(n)` / `d(k,n)` | `1 + rn2(n)`, k times |

Two consequences worth writing down. First, `align` is shuffled at nhlib load
time, so **every `nhl_init()` spends two draws before the script runs** — which
is why the port must not create its state with `nhl_init`. Second, a fork-local
modification seeds Lua's own xoshiro PRNG from `$NETHACK_SEED`
(`nhlua.c:3096`); it is vestigial, because nhlib's shim shadows `math.random`
before any script sees it, but it means a naive "just use Lua's math.random"
port would silently draw from the wrong stream.

The RNG log's `@ caller` suffix — which `nhl_rnglog_set_lua_caller()` fills in
with the script name and line — is **stripped by the scorer**
(`frozen/ps_test_runner.mjs:62 normalizeRng`), so a port calling `rn2()` from JS
does not have to reproduce Lua source coordinates. Only the
`rn2(x)=result` sequence is compared.

### (c) Metatables, coroutines, closures

No script defines a metatable or uses a coroutine. Metatables exist only C-side,
for the selection `|`/`&`/`~`/`-` operators (`l_selection_meta[]`,
nhlsel.c:1009); a port expresses those as explicit `selection.*` calls, which is
what the metamethods dispatch to anyway.

Closures are pervasive but shallow: 284 anonymous `contents = function() … end`,
nested at most four deep (`themerms.lua`'s Fake Delphi). They port as JS arrow
functions pushed with `lua_pushcclosure`; `lua_type()` reports `LUA_TFUNCTION`
for a light C function exactly as for a Lua closure, so `lspo_room`'s
`lua_isfunction` check and its `nhl_pcall_handle(L, 1, 0, …)` behave identically.

`nhcore.lua:39` `_G[k](table.unpack{...})` — string-keyed dynamic dispatch over
globals — is the only reflective code in the corpus and the single hardest thing
to port. It is confined to the callback registry.

### (d) Errors and pcall

`nhl_loadlua` runs the chunk inside `nhl_pcall_handle(…, NHLpa_impossible)`;
a Lua error becomes `impossible()` and the level generation is abandoned. The
bridge mirrors that: `runPortedScript()` pushes the port body as a
`lua_CFunction` and invokes it through `lua_pcallk`, so a `luaL_error` raised
inside an `lspo_*` (bad argument, unknown monster name) unwinds through the same
machinery instead of tearing a `longjmp` through JS frames. A JS-level throw
inside the port body is caught, stashed, and re-thrown after the pcall returns,
so the Lua stack is unwound before the harness sees it.

---

## 4. Interception mechanism

`nhl_loadlua` cannot be wrapped, but the file read inside it can: the harness
owns `fopen`/`fread`/`fclose` and the vendored playground behind them. So the
port hooks the VFS (`js/boot/harness.mjs`, `js/lua-js/registry.mjs`):

* **at `fopen`** — if the script is ported, the bytes handed to the interpreter
  are swapped for `stubFor()`: same length, same line breaks, everything wrapped
  in a `--[[ ]]` long comment, so it compiles to an empty chunk. Equal length
  matters because `nhl_loadlua` does `alloc(buflen + 2)` against *NetHack's*
  heap, and this fork has already been bitten once by allocator-shaped
  differences (`docs/LANDMINE-uninit-cmdstr.md`).
* **at `fclose`** — the port runs. That is the tightest seam available: the file
  has been fully read, `nhl_init()` has already built the interpreter's state
  and spent nhlib's two align draws, and nothing else has happened. The only
  reordering is that the Lua parse of an empty chunk now happens *after* the
  `des.*` calls instead of before — and parsing touches neither NetHack's
  globals nor its RNG.

Off-by-default safety is structural, not conventional: `registry.active()`
returns false when `PORTS` is empty or `C2JS_LUA_PORT=0`, the harness leaves its
`luaPort` binding `null`, and every hook site is behind a `luaPort &&` guard. The
registry module is imported *after* `js/generated/unixmain.js` so the generated
graph's cyclic module initialisation order is unchanged.

---

## 5. Proof of concept: `oracle.lua`

**Why this script.** It is 2.5 KB, it is generated by `makemaz()` on one level of
Dlvl 5–9 in *every* game (so it is reachable from the existing corpus rather than
requiring a bespoke seed), and it exercises the hardest marshalling case —
six `des.room` calls with `contents` closures, one of them nested two deep —
while containing no script-level RNG of its own. That last property is what makes
it the right *first* port: equivalence reduces exactly to "the same `des.*` calls
in the same order with the same arguments", with no shuffle or percent logic
confounding a failure.

Port: `js/lua-js/scripts/oracle.mjs`, 90 lines, a line-for-line transliteration.

### Differential oracle: `tools/lua-oracle.mjs`

Runs a session twice in two isolated module graphs (`js/boot/isolation.mjs`'s
resolve hook, so run B does not inherit run A's C globals) —
`C2JS_LUA_PORT=0 C2JS_LUA_TRACE=1` for the interpreter and `C2JS_LUA_PORT=1` for
the port — and compares:

1. the whole PRNG call log, normalised the way the scorer normalises it;
2. the whole screen sequence;
3. the RNG-log index at which each ported script was loaded (localises a
   divergence to before-the-script vs inside-the-script);
4. a **level fingerprint** taken at the first key read after the script ran:
   FNV-1a over the terrain type of all 80×21 squares, then over every object
   (position + `otyp`) and every monster (position + species) on the level.

The fingerprint is what makes the oracle sharp. Point 1 and 2 alone are not:
they are the contest's own observables, and a level can differ in ways neither
sees.

### Result

```
$ node tools/lua-oracle.mjs sessions-extra/gen9996-marathon-dlvl10.session.json
PASS  gen9996-marathon-dlvl10.session.json
      rng     interpreter=54924 port=54924 firstDiff=-1
      screens interpreter=17829 port=17829 firstDiff=-1
      ported-script loads: oracle.lua@rng39082
      port loads:          oracle.lua@rng39082
      rng draws inside port: [2135]
      level typ fingerprint: interpreter=622efd38 port=622efd38 MATCH
```

The port consumes 2,135 RNG draws inside `oracle.lua` — all of them from the C
bindings, none from the script — and the two runs agree on all 54,924 draws, all
17,829 screens and the level content hash.

### Negative control

The oracle is only worth its output if it can fail. Moving one statue from
`(2,4)` to `(2,5)` in the port — a change that consumes identical randomness and
that the marathon session's player never looks at — leaves the RNG log and every
screen **identical** and is caught only by the fingerprint:

```
FAIL  gen9996-marathon-dlvl10.session.json
      rng     interpreter=54924 port=54924 firstDiff=-1
      screens interpreter=17829 port=17829 firstDiff=-1
      level typ fingerprint: interpreter=622efd38 port=6faad691 MISMATCH
```

This is worth internalising before porting script #2: **RNG + screens are not a
sufficient oracle for a level script.** They were the right referee for the
engine port, where every C statement is on the observable path; they are not for
level content, most of which the player never sees.

---

## 6. Corpus regression

Both configurations, full 69-session corpus
(`SESSION_REPLAY_TIMEOUT_MS=300000 node frozen/ps_test_runner.mjs sessions/ sessions-extra/`):

| Configuration | Result |
|---|---|
| (a) registry inert — `C2JS_LUA_PORT=0` | **69/69** |
| (b) `oracle.lua` ported and live (default) | **69/69** |

`gen9996-marathon-dlvl10` is the session that reaches the Oracle level; it scores
`RNG 54924/54924, Screen 17829/17829` in both configurations, i.e. the port is
byte-exact against the **C recorder**, not merely against the JS interpreter.

Other gates: `tools/c2js/test-rnd.mjs`, `test-hacklib.mjs`, `test-setjmp.mjs`,
`test-union.mjs` PASS; `node --test test/*.test.mjs` 4/4 (includes posix-ere);
judge-sim `run.mjs seed8000` PASS.

---

## 7. Cookbook — porting script #2

1. **Read the Lua.** `nethack-c/recorder/dat/<name>.lua`.
2. **Write `js/lua-js/scripts/<name>.mjs`** exporting a default function taking
   the API object. Transliterate, do not redesign — the diff against a future
   5.1 version of the script is the Phase-2 score, so keep the shape.
   ```js
   export default function myLevel({ des, selection, percent, shuffle }) {
       des.level_init({ style: 'mazegrid', bg: '-' });
       des.map({ map: [...].join('\n'), ... });
       if (percent(30)) des.object({ id: 'chest', x: 4, y: 2 });
   }
   ```
   * Lua table constructor → JS object literal, **keys in source order**.
   * Lua array `{a,b,c}` → JS array.
   * `contents = function() … end` → `contents: () => { … }`; if the closure
     uses its `rm` parameter, declare it (`contents: (rm) => …`) and the bridge
     materialises the mkroom table.
   * `math.random`/`percent`/`shuffle`/`d` → the API's versions, never JS's
     `Math.random`.
   * A multi-line `[[ … ]]` map string → a JS template literal or
     `[...].join('\n')`; keep the exact bytes.
3. **Register it** in `js/lua-js/registry.mjs`'s `PORTS` map.
4. **Prove it.** Find a session that generates the level (trace mode reports
   which ported scripts a session reaches), then
   `node tools/lua-oracle.mjs <session>`. Require all four checks green,
   *especially the fingerprint*. If no corpus session reaches the level, record
   one — `tools/play-record.mjs` / `tools/generate-sessions.mjs` — and add it to
   `sessions-extra/`; a port with no reaching session has no oracle.
5. **Regress.** Full corpus with the port on; and once per batch, with
   `C2JS_LUA_PORT=0`, to confirm the registry is still inert when disabled.

### Gotchas found the hard way

* Do not call `nhl_init()` to make a Lua state; it spends two RNG draws.
* Do not add `luaL_openlibs` to the port state; the `lspo_*` bindings do not need
  any Lua library, and opening `math` would re-seed a PRNG nobody reads.
* `luaL_checkinteger` rejects non-integral numbers — the bridge pushes JS numbers
  as Lua integers when `Number.isInteger`, which is what every des field wants.
* A JS `throw` inside a port body must not cross a Lua C frame; `runPortedScript`
  stashes and re-throws after the pcall.

---

## 8. Staged plan for the remaining 130 scripts

Ordered by risk-adjusted value. "Legs" = agent sessions, roughly.

| Stage | Scripts | Count | Why here | Legs |
|---|---|---|---|---|
| **S1** *pure-data* | `quest.lua`, `dungeon.lua` | 2 | 21.7 % of the corpus by bytes, zero executable statements. But **not** through the des bridge: both are read by `lua_getfield`/`lua_next` walks from `init_dungeons()` and `com_pager()` against a table the chunk leaves in the globals, so the port has to *build the global table*, not issue calls. Needs one new bridge primitive (`setGlobalTable`) and, for `dungeon.lua`, replication of the array-part traversal order. Distinct mechanism, so do it early and alone. | 2 |
| **S2** *T0 level scripts* | 49 remaining T0 files: `soko1-1 … soko4-2`, `air/fire/water/earth`, `baalz`, `tower3`, `tut-2`, all quest `*-goal/-loca/-fil*` | 49 | Mechanical transliteration, no RNG, no closures. The bulk of the file count for the least risk. Batch 8–12 per leg. Reachability is the constraint, not correctness: Sokoban, the Planes and the quest branches need recorded sessions that get there — budget a leg for session recording first. | 6 |
| **S3** *T1 + closure-only T2* | `castle`, `juiblex`, `sanctum`, `*-strt`, `minend-1/3`, `fakewiz1/2`, `wizard2`, the 10 `*-fil{a,b}` | 28 | Adds `shuffle` over literal tables and single closures. Both already exercised by the PoC and the bridge. | 4 |
| **S4** *T2 with real logic* | `minetn-*`, `medusa-*`, `bigrm-*`, `astral`, `knox`, `valley`, `orcus`, `Wiz-loca`, `minefill`, `tower1/2`, `wizard1/3`, `asmodeus`, `Kni-strt`, `Tou-goal/loca`, `Val-*`, `Bar-strt`, `Mon-strt`, `Pri-strt`, `soko1-1/2`, `oracle` ✅ | 30 | Loops, `percent`, selection algebra. First real use of `selection.*` handles through the bridge — `LuaValue` exists but is only smoke-tested; expect a leg of bridge work for selection operators (`|`, `&`, `~`) and `:iterate(closure)`. Mines levels are corpus-reachable, which makes this the best-tested stage after S2. | 6 |
| **S5** *tutorial* | `tut-1`, plus the tutorial half of `nhlib` | 2 | The only string-pattern code in the corpus (`s:match("^^([A-Z])$")`) and the only place `nh.eckey` interpolation matters. Self-contained and never reached in normal play, so low risk and low value — do it late, or not at all before the freeze. | 1 |
| **S6** *the libraries* | `nhlib.lua`, `nhcore.lua` | 2 | The hard ones, and the ones that change the load-time RNG contract. Porting `nhlib` moves the `align` shuffle into JS and requires the bridge to own per-state library state; porting `nhcore` requires reproducing `pairs()` order over a string-keyed table and `_G[k]` dispatch. **Only worth doing if S1–S4 land comfortably before the freeze**; the interpreter running two small library files costs nothing in the Phase-1 baseline. | 3 |
| **S7** *themed rooms* | `themerms.lua`, `hellfill.lua` | 2 | 46 KB, 122 functions, frequency-weighted reservoir sampling, deferred post-process callbacks, and the *only* long-lived level-gen state (`gl.luathemes[dnum]`, cached per branch and never closed). `themerms` runs on essentially every ordinary level, so a mistake here is a corpus-wide failure rather than a one-level one — but that also means the corpus tests it hardest. Highest value in a Phase-2 diff (themed rooms are the most likely thing to change in 5.1) and highest risk. | 4 |

Total ≈ 26 agent-legs. S1–S4 (109 scripts, ~78 % of the file count) is ≈ 18 and
is the sensible pre-freeze target; S6/S7 only if that lands early.

---

## 9. Biggest risk to full coverage

**Reachability, not correctness.** The bridge is proved and the oracle is sharp,
but an oracle only reports on levels a session actually generates. Of the 131
scripts, the existing 69-session corpus reaches perhaps a dozen: Dlvl 1–10 of the
Dungeons of Doom, the Mines entrance, and `oracle.lua`. The quest branches
(49 files), Sokoban (8), Gehennom (≈15), the Planes (5) and Vlad's Tower (3) are
all behind gameplay that no recorded session performs — and several require a
level teleporter, an amulet, or a quest nemesis to reach at all.

That leaves two options for roughly half the corpus, both with costs. Either
extend the corpus with long recorded sessions that descend far enough (expensive
to record, slow to replay, and the deep branches may be unreachable in a
scripted run at all), or build a **level-generation-only harness** that boots the
game, forces `makemaz()` to load a chosen script at a chosen depth, and compares
the fingerprint — no player, no screens, no session. The second is much cheaper
and covers everything, but it validates level *generation* in isolation rather
than the whole game, so a port that is right in the harness and wrong in play
would slip through. The honest answer is both: the synthetic harness for
coverage, the corpus for truth, and an explicit note in each stage's write-up
saying which scripts have only synthetic evidence.

The secondary risk is `themerms.lua` (S7): it is the one script whose state
outlives its load, it runs on nearly every level, and its reservoir sampling
means a single misordered `nh.rn2` shifts every subsequent room in the dungeon.
It should be attempted only with the whole corpus green and a leg budgeted for
backing it out.
