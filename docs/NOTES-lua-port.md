# Lua → JS script port (roadmap 1.10)

NetHack ships its special levels, dungeon layout, quest text and themed rooms as
131 `.lua` scripts, executed by a Lua 5.4.8 interpreter that this fork transpiles
along with the rest of the C. Roadmap 1.10 ports those scripts to readable
JavaScript under `js/`, keeping the transpiled interpreter in the tree as a
**differential oracle**: for every ported script we can run both and prove them
equivalent.

This note is the architecture decision, the traps analysis, the proof-of-concept
result, the cookbooks for porting the next script, and the staged plan for the
rest.

Status: **complete — PoC + S1 + S2 + S3 + S4 + S5 + S6 + S7 landed, and
refreshed onto `main` at 8c7b833 (§16), where the ports now share a realm with
the resettable graph instead of getting a fresh fork per segment.**
`oracle.lua`, `dungeon.lua`, `quest.lua`, the whole 49-file T0 tier, S3's
28-file T1 tier, S4's 46-file T2 tier, S5's `tut-1.lua`, S6's two library files
`nhlib.lua` and `nhcore.lua`, and S7's `themerms.lua` and `hellfill.lua` are
ported and live — **all 131 files, 100 % of the corpus by bytes**. The corpus
passes with the ports enabled and with them disabled, and **a game with every
port live parses zero bytes of Lua source**: the registry's census reports
`.lua still parsed: NONE` on every session tried, including the ones that force
a Gehennom filler level (§15.9).

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

> **S7 update.** All four are ported. `hellfill.lua` turned out to be an
> ordinary *generated* level script — the emitter needed one new construct,
> Lua's own `type()` — and `themerms.lua` is the only file in the corpus that
> needed a shape of its own, because its state outlives the level (§15).

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

> **S4 made this precise.** "Expresses those as explicit calls" would have been
> wrong if it meant calling `l_selection_or` directly — those functions are
> `staticfn` and unreachable, and calling them would skip the dispatch rather
> than reproduce it. The port drives `lua_arith()`, whose path into
> `luaT_trybinTM` is the one `OP_BOR` itself takes. §12.1.

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

> **Superseded in S2, in S3 and in S4.** The fingerprint now covers every
> *content* field of `struct rm` and several more object and monster fields
> (§7.5), the container and monster-inventory chains (§11.3), and finally every
> field of `struct obj` and `struct monst` plus the trap chain (§12.5). The
> hashes quoted in the rest of this section are the S1 values and no longer
> reproduce; the reasoning does.

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

## 6. Stage S1: the read-back scripts — `dungeon.lua`, `quest.lua`

**Landed.** Both are ported. Together they are 21.7 % of the .lua corpus by
bytes and contain zero executable statements — and, unlike every level script,
neither of them calls a single C binding. Their entire product is a Lua table
that the game reads back afterwards:

| Script | Loaded by | Reads it back with | Lifetime of the state |
|---|---|---|---|
| `dungeon.lua` | `init_dungeons()` (dungeon.c:1221) | `lua_getglobal("dungeon")` + `lua_len` + **`lua_next`** (dungeon.c:1254–1278) | its own `nhl_init()`, `nhl_done()` at the end of the function |
| `quest.lua` | `com_pager_core()` (questpgr.c:494) | `lua_getglobal("questtext")` + `lua_getfield` × 3 + `lua_len`/`lua_gettable` (questpgr.c:501–560) | its own `nhl_init()`, `nhl_done()` **per delivered message** |

Both run in **every** game, which was the pleasant surprise of this stage — see
§6.6.

### 6.1 The trap was not the one we were watching for

§3(a) flagged Lua table traversal order as the hazard for anything read back
with `lua_next`. It is a real hazard, and it is *not* the thing that stops a
naive port. The thing that stops it is one level lower:

> **A table built in the port's own `lua_State` is invisible to the game.**

Candidate A′ works for a level script precisely because the script's effects
leave through C bindings that key off NetHack's globals, so it does not matter
which state marshalled the arguments. For a read-back script it matters
absolutely: `init_dungeons()` calls `lua_getglobal` on **its own** `L`, a local
variable in transpiled C, created by its own `nhl_init()` call. Nothing global
holds it — `gl.luacore` is nhcore.lua's state, not this one — and `nhl_loadlua`
cannot be wrapped for the same reasons §4 gives. The port that ran `oracle.lua`
would have left the interpreter's `dungeon` global undefined and panicked with
`"dungeon is not a lua table"`.

The way out is that Lua allocates a state as *one block through the embedder's
allocator*, and this embedder's allocator is ours:

```
lua_newstate → nhl_alloc (nhlua.c:3132) → re_alloc (alloc.c:85) → realloc → js/boot/harness.mjs
```

`js/lua-js/interp-state.mjs` watches for a fresh allocation of exactly
`sizeof(LG)` (1,624 bytes; `js/generated/lstate.js:346`) and confirms the
candidate structurally, using the two fields `lua_newstate()` fills in and never
changes: `g->mainthread` must point back at `l + LUA_EXTRASPACE`, and
`g->frealloc` must be a function. A self-referential pointer at a fixed offset
is not something an unrelated 1,624-byte allocation produces by accident, so
the check is structural rather than statistical. This is the same kind of
knowledge `levelFingerprint()` already uses to read `levl[x][y].typ` out of
`svl`: struct offsets taken from the transpiler's own output, reading memory
the game owns, with nothing in `js/generated` touched.

Discovery is then verified once more before use — `stateIsFresh()` requires
that the global the script is about to define does not exist yet — and a
failure **throws**. There is deliberately no fallback to the interpreter: a
silent fallback is exactly the failure mode that would let a broken port pass
the corpus.

The new bridge primitive on top of it is `setGlobal(L, name, value)`
(`js/lua-js/bridge.mjs`), which emits the same
`lua_createtable`/`lua_setfield`/`lua_rawseti`/`lua_setglobal` sequence the VM's
`OP_NEWTABLE`/`OP_SETFIELD`/`OP_SETLIST`/`OP_SETTABUP` would have emitted for
the file's one table constructor.

### 6.2 Traversal order, measured

With the state problem solved, the traversal question became answerable
empirically rather than by argument. `C2JS_LUA_READBACK=dump` fingerprints the
finished table two ways at once (`js/lua-js/readback.mjs`): a **canonical**
content hash (integer keys ascending, then string keys sorted) and a **raw
`lua_next` order** hash. The answer splits cleanly:

* **`dungeon.lua` — order matters, and it matches exactly.** The `dungeon`
  global is a pure sequence of nine entries, so `lua_next` walks the array part
  in ascending index order, and `lua_createtable(narr, 0)` reproduces the
  parser's layout by construction. Measured: content `e01af569`, order
  `51ed75a5`, key sequence `1,2,3,4,5,6,7,8,9`, on both sides — with the *same*
  hash seed (`3606532568`), because `dungeon.lua` loads early enough in
  `newgame()` that the allocation history up to that point is identical.
* **`quest.lua` — order differs, and cannot be otherwise.** `questtext`'s top
  level is 15 string keys, which live in the hash part, and where a string key
  lands in the node vector depends on `g->seed`, which `luai_makeseed()`
  (`js/generated/lstate.js:34`) derives from `time()` and from pointer values.
  The port and the interpreter allocate different amounts, so they get
  different seeds and different orders.

That second point needed proof, not assertion, and the quest probe supplies it
in a single run: `com_pager_core()` builds a *fresh* `nhl_init()` state for
every message, so one probe run loads the identical `quest.lua` eight times and
the **interpreter alone** produces eight different traversal orders —

```
5041e48d  Kni,msg_fallbacks,Cav,Ran,Tou,Mon,Bar,common,Arc,Rog,Wiz,Sam,Val,Pri,Hea
578b8b7   common,Wiz,Cav,Val,Sam,Tou,Hea,Rog,Pri,Mon,msg_fallbacks,Bar,Kni,Arc,Ran
a7d74df7  Sam,Ran,common,Wiz,Cav,Val,Hea,Tou,Mon,Rog,msg_fallbacks,Pri,Kni,Bar,Arc
313e0b36  common,Val,Wiz,Kni,Sam,msg_fallbacks,Tou,Rog,Pri,Mon,Bar,Ran,Arc,Cav,Hea
1f5ee51e  common,Cav,Arc,Hea,Wiz,Val,Bar,Tou,Pri,Sam,Kni,Ran,msg_fallbacks,Mon,Rog
27a88562  msg_fallbacks,Ran,Mon,Wiz,Arc,Val,Pri,Tou,Kni,Sam,Rog,Hea,Cav,Bar,common
b64c4e59  Tou,Wiz,Cav,Val,Bar,Rog,Sam,Ran,common,Pri,Mon,Kni,msg_fallbacks,Hea,Arc
c22cceb0  Rog,Sam,Pri,Wiz,msg_fallbacks,common,Mon,Cav,Arc,Ran,Kni,Val,Tou,Hea,Bar
```

— while the content hash is `3ee3deb7` on all sixteen dumps, interpreter and
port alike. Hash-part traversal order is a property of the state, not of the
data; nothing in NetHack can depend on it, and indeed nothing does. `lua_next`
appears exactly twice in the whole non-Lua C source, and the only one that
touches a script-built table is `dungeon.c:1278` — the array-part case.
`com_pager_core()` reads `questtext` only by `lua_getfield` and by integer
index.

So the oracle requires the canonical hash to match everywhere, and the raw
order to match for the table C actually walks.

### 6.3 Lifetime — shorter than expected, for both

The stage brief expected `dungeon.lua`'s table to be one-shot and `quest.lua`'s
to have to survive for mid-game message lookups. Reading `com_pager_core()`
settles it: **`quest.lua` is one-shot too, once per message.** Every single
quest or `common` message re-runs `nhl_init()`, re-reads all 132 KB, and calls
`nhl_done()` before returning; nothing persists between deliveries. The probe
run's eight loads for eight messages is that fact on the record.

The consequence for the port is that it owns no state and no lifetime at all.
It writes one global into a state somebody else made and somebody else will
close, exactly as the chunk would have, and the JS data module (which *is*
long-lived, and shared across replay segments — `js/boot/isolation.mjs`'s
`SHARED`) is pure immutable data that is never handed to Lua as an object, only
walked to emit pushes.

Two things follow that are worth writing down for S6:

* The port marshals ~1,500 table entries into a Lua state that `nhl_init()`
  created with a **1 MB sandbox memory cap** (`nhl_sandbox_info`, and
  `nhl_alloc` returns NULL past `nud->memlimit`). It fits, with room, because
  the port allocates strictly less than the interpreter did: the interpreter
  pays for the source buffer and the compiled `Proto` with its ~3,000 string
  constants *as well as* the table. But this is why `setGlobal` runs inside
  `runProtected()` — a `LUA_ERRMEM` has to be caught by a Lua frame, not thrown
  through JS.
* Re-running the whole marshalling per message is what the interpreter does
  too, so it is parity-neutral. A lazy `__index` table would be much faster and
  is *probably* unobservable (every read is `lua_getfield`), but "probably" is
  not the standard here and speed is not the constraint.

### 6.4 Ordering at the seam

§4's interception runs the port at `fclose`, which for these two scripts is
what makes the ordering trivially right: the file has been read, the state
exists and has been fully initialised by `nhl_init()`, the global is set, and
only then does `nhl_loadlua()` compile the (empty) stub and `init_dungeons()` /
`com_pager_core()` start reading. The reordering §4 describes — the parse
moving after the port's work — is if anything *more* obviously harmless here,
since the port's work is a table assignment rather than a sequence of `des.*`
calls.

`stateIsFresh()` checks the invariant directly: at the moment the port runs,
the global it is about to define must still be absent.

### 6.5 The generator

132 KB of quest prose is not hand-transcribed.
`tools/lua-port-gen/lua2js.mjs` parses the declarative subset those two files
use — comments, string/number/boolean/nil literals, long strings, and table
constructors with record, bracketed and positional fields — and emits
`js/lua-js/data/{dungeon,quest}.mjs` as nested JS literals in source order.
Anything outside that subset is a hard error, so a 5.1 `quest.lua` that grows a
function call fails loudly instead of being silently mistranslated. Multi-line
strings become template literals so the prose stays diffable against the .lua.

Neither file contains a table with both positional and keyed fields, which is
what lets the emitted JS be plain arrays and plain objects: array ⇒ array part,
object ⇒ hash part, and `setGlobal` can derive `lua_createtable`'s `narr`/`nrec`
from the shape. `test/lua-port-data.test.mjs` enforces both halves of that on
every run — it re-parses the .lua and requires the committed module to be the
same value with the **same key order**, and rejects any integer key in a record
table.

### 6.6 Reachability: both scripts are exercised by every recorded session

This was expected to be the weak point of S1 (§10 is about exactly this) and it
turned out not to be one.

* `init_dungeons()` runs at every `newgame()`, so `dungeon.lua` is loaded by all
  69 corpus sessions.
* `newgame()` ends with `com_pager("legacy")` when `flags.legacy` is set, which
  is the default (allmain.c:832) — so **`quest.lua` is loaded by all 69 sessions
  too**, and the text it returns is put on the screen. In the trace, a
  chargen-only session shows `dungeon.lua@rng202, quest.lua@rng3193`.

Neither port consumes any RNG (`rng draws inside port: [0,0]`), which is right:
the parse never did either, and every draw `init_dungeons()` spends — one
`rn2(100)` per dungeon for the `chance` roll, then `place_level()`'s recursion
— is C-side and unchanged.

What the corpus does *not* reach is `quest.lua`'s 13 role sections; a normal
game only ever reads `common.legacy`. `C2JS_LUA_QUESTPROBE=1` covers that gap
synthetically: once the game is up, the registry delivers five role-specific
messages through `qt_pager()` and two `common` ones through `com_pager()`, and
the oracle compares the **raw terminal byte stream**. That last detail matters
— a `--More--`-paged quest window is drawn and dismissed inside a single key
wait, so it never lands on an input-boundary screen at all, and comparing the
sampled screens would have proved nothing.

Honest summary of the evidence status:

| Path | Evidence |
|---|---|
| `dungeon.lua` → `init_dungeons()` | real play, all 69 sessions |
| `quest.lua` → `common.legacy` | real play, all 69 sessions |
| `quest.lua` → 13 role sections, 28 msgids | synthetic (`C2JS_LUA_QUESTPROBE`), 7 roles |
| every string in `questtext`, every field in `dungeon` | the read-back dump, exhaustive |

### 6.7 Oracle results

`node tools/lua-oracle.mjs --readback --questprobe <session>`:

```
PASS  seed0077-rogue-chargen.session.json
      rng     interpreter=3242 port=3242 firstDiff=-1
      screens interpreter=33 port=33 firstDiff=-1
      ported-script loads: dungeon.lua@rng202, quest.lua@rng3193
      rng draws inside port: [0,0]
      level typ fingerprint: interpreter=0,4ac51dab port=0,4ac51dab MATCH
      read-back table:     MATCH (269/1527×8 values hashed; lua_next order over the walked table MATCH)
        [0] dungeon.lua:dungeon:e01af569:269
        [1] quest.lua:questtext:3ee3deb7:1527
      quest-text delivery: MATCH (8 quest.lua loads, 23882 terminal bytes, firstDiff=-1)
```

Seven roles — Healer, Samurai, Knight, Wizard, Tourist, Caveman, Rogue — all
`PASS` on all five checks.

### 6.8 Negative controls

Three, because three different checks had to be shown capable of failing.

1. **Content, invisible to play.** One character changed in the Wizard
   section's `firsttime` text — a string the rogue session never displays.
   `rng 3242/3242 firstDiff=-1`, `screens 33/33 firstDiff=-1`, level
   fingerprint `MATCH`; caught only by the read-back hash
   (`3ee3deb7` → `2094187e`). This is the §5 statue control's exact analogue,
   and it is why the read-back dump exists.
2. **Order.** Swapping the last two entries of the `dungeon` sequence moves the
   raw order hash (`51ed75a5` → `239ce7bf`) while the top-level key sequence is
   still `1,…,9` and the seed is identical on both sides. Reordering a sequence
   necessarily changes its contents too, so the content hash catches this one
   as well; what the control establishes is that the order check fires and that
   the printed key list on its own would not have.
3. **Delivered text.** One letter changed in the Rogue's home-town name:
   RNG log identical (`rngFirstDiff=-1`), terminal stream diverges at byte
   8697. The delivery path is genuinely under test.

---

## 7. Stage S2: the 49 pure-declarative level scripts

**Landed.** Every T0 level script is ported: the 34 quest `*-goal` / `*-loca` /
`*-fil{a,b}` levels, six Sokoban levels, the four Elemental Planes, `baalz`,
`minetn-6`, `tower3` and `tut-2`. 3,883 lines of Lua, 136 KB — with S1 and the
PoC that is 52 of 131 files and 44 % of the corpus by bytes.

The porting itself is exactly what §9's cookbook says it is. The craft in this
stage is in three other places: a generator sharp enough that the *result* is
readable rather than a compiler artifact, a way to get an oracle on 33 scripts
no recorded session reaches, and a fingerprint sharp enough that the oracle
would have noticed if the port were wrong.

### 7.1 The generator

`tools/lua-port-gen/lua2des.mjs` parses the call-stream subset — comments,
`des.NAME(args)` statements, `local NAME = exp`, literals, long strings, table
constructors, `a.b`, `a[k]`, `a:m(args)`, nested calls and `..` — and emits one
JS module per script. Anything outside that subset is a **hard error**: the
lexer rejects `if`/`for`/`function`/`return` by name, so a 5.1 script that grows
control flow fails loudly instead of being quietly mistranslated. That is the
same contract S1's `lua2js.mjs` has for the data files, and the reason a
generator is safe to use at all.

`tools/lua-port-gen/gen-ports.mjs` (called `gen-t0.mjs` until S3) drives it
over the 49 files (the list is
explicit and reviewable, not rediscovered by a heuristic at runtime) and emits
`js/lua-js/scripts/t0/index.mjs`, which `registry.mjs` merges into `PORTS`.

The output is meant to be diffed against a future 5.1 `.lua`, so it keeps the
source's shape: statement order, comments in place, blank lines where the .lua
had them, and table constructors broken across the same lines the Lua broke
them across. Maps stay whole as template literals, first row against the
backtick because Lua's `[[` eats one newline and JS's backtick does not.

```js
export default function Arc_goal({ des, selection }) {
    des.level_init({ style: 'solidfill', fg: ' ' });
    // Dungeon Description
    des.region(selection.area(0, 0, 75, 19), 'lit');
    des.region({ region: [43, 13, 50, 15], lit: 0, type: 'temple', filled: 2 });
}
```

### 7.2 The transcription proof

`--check` imports the emitted module, runs it against a recording stub API, and
compares the resulting call stream — every call, every argument, every table key
in order — against the stream the parser derives from the `.lua`.
`test/lua-port-scripts.test.mjs` runs that over all 49 on every `node --test`,
in about 100 ms, and also asserts that the registry's index lists exactly the
tier in order.

This is not belt-and-braces; it covers a failure mode the differential oracle
cannot. 21 of the 34 maps have **significant trailing spaces**, and they live
inside JS template literals now. An editor or formatter that strips trailing
whitespace would corrupt 21 levels in a way no reviewer would see in a diff.
The call-stream check compares the map bytes.

Values that only exist at runtime — `nh.eckey("up")`, `align[1]`,
`monkfoodshop()` — are compared as sentinel strings, so a port that read
`align[2]` fails the check as loudly as one that moved a boulder.

### 7.3 What the tier contained besides `des.*`

The mechanical T0 score counts tokens in the level script; it does not follow
calls out of it. Six things needed more than the cookbook:

* **`align[1]`** (`Arc-loca`, `minetn-6`). nhlib.lua's `align = {"law",
  "neutral", "chaos"}` is *shuffled* at the top of every `nhl_init()`, spending
  the two RNG draws §3(b) warns about. The result exists only in that state, so
  the port cannot recompute it — recomputing would cost two more draws and
  desynchronise immediately. `bridge.mjs`'s `interpAlign()` reads it out of the
  interpreter's own state with `lua_getglobal` + `lua_rawgeti`, using S1's
  `interpState()`. It is exposed as a **getter** on the api object, so only the
  two scripts that name it pay for the state lookup.
* **`monkfoodshop()`** (`minetn-6`). An nhlib function with an `if` in it:
  `u.role == "Monk"` picks "health food shop" over "food shop". `u.role` is
  `nhl_u_index`'s own `gu.urole.name.m`, so the JS is one pointer read. Both
  branches are exercised — a Monk session and a Rogue session both PASS.
* **`nh.eckey("up")` and `..`** (`tut-2`). The engraving text is built at
  runtime from a key binding. The port calls the same `cmd_from_ecname()` the
  binding calls and joins with JS `+`.
* **`selection.negate():filter_mapchar('.')`** (`Mon-loca`). Method sugar:
  nhlsel.c registers one function table and points the metatable's `__index` at
  it, so `sel:m(x)` and `selection.m(sel, x)` are the same call. The port spells
  out the second form.
* **`{ class = "B",random, peaceful = 0 }`** (`Wiz-goal`, 19 times). A stray
  token in NetHack's own source: `random` is a global nothing defines, so Lua
  stores nil at index 1, which stores nothing. Dropped, with the reason in the
  module header.
* **`place[4]`** (`tower3`). A local list of niche coordinates, indexed with
  Lua's 1-based indices. `luaList()` returns an array whose `[1]` is the first
  element, so the JS index reads the same as the Lua one. An off-by-one between
  a .lua and its port is exactly the thing a Phase-2 reviewer should not have to
  hold in their head.

### 7.4 The bug this stage found: the port's own state shadows the interpreter's

`interpState()` (§6.1) finds the interpreter's `lua_State` by watching the
allocator for a fresh block of exactly `sizeof(LG)` and taking the newest one
that verifies structurally. The bridge's **own** state is allocated the same way
and is exactly as long, and `bridge.mjs` creates it lazily — on the first ported
script that needs it. So the first ported *level* script in a run creates the
port state immediately before its body executes, making it the newest candidate,
and a body that then asked for the interpreter's state got its own — in which
nhlib was deliberately never loaded.

It surfaced as `lua-port: nhlib's 'align' global is not a table` when
`minetn-6` was probed on its own, and *not* when it was probed 47th, which is
the shape of bug that hides for a long time. S1 never met it because
`dungeon.lua` and `quest.lua` load during `newgame()`, before any level script
exists to create the port state.

The fix is identity, not heuristics: `bridge.mjs` calls
`markPortState(L)` at creation and `interpState()` skips that one block. The
structural check could not have distinguished them, because both really are
`lua_State`s. This matters for S3 onward, where more ports will want `align`.

### 7.5 A sharper fingerprint

S1's fingerprint hashed `rm.typ`, and for each object and monster its position
plus `otyp` / species. That is enough to catch a statue placed one square over
(§5's control) and not enough for this tier:

* `des.altar{ align = align[1] }` writes `rm.flags` (the altar mask). Terrain
  type is still `ALTAR` either way.
* `des.door("locked", …)` writes `rm.flags` too; `des.region(…, "lit")` writes
  `rm.lit`.
* `des.object{ id = "crystal ball", spe = 5, … }` writes `obj.spe`.
  `quantity`, and `montype` on a statue, are equally invisible in `otyp`.
* `des.monster{ id = "air elemental", peaceful = 0 }` — `air.lua` sets it 40
  times — writes `monst.mpeaceful`.

Every one of those consumes identical randomness whether the port gets it right
or wrong, so S1's five checks would all have passed. The fingerprint now covers
every content field of `struct rm` (`typ`, `flags`, `horizontal`, `lit`,
`waslit`, `roomno`, `edge`, `candig`), the objects' `otyp`/`spe`/`quan`/
`corpsenm` and the monsters' species/`female`/`mpeaceful`. The offsets come from
the transpiler's own output the same way §6.1's did — enumerating every offset
the generated code uses with the `struct rm` stride recovers the whole struct,
because this transpile widens each C bitfield into its own 32-bit slot.

Still deliberately excluded: heap pointers (the two sides allocate different
amounts by construction) and the two *display* fields, `glyph` and `seenv` —
what the hero has seen is not what the script built.

> **Superseded in S3, and again in S4.** Even this only sweeps the *floor*.
> §11.3 widens it to the two chains a floor sweep cannot reach — `obj->cobj`
> and `monst->minvent` — which is where the whole T1 tier puts its interesting
> objects; §12.5 stops enumerating fields by hand altogether and takes the
> whole of `struct obj`, `struct monst` and the `gf.ftrap` chain from the
> transpiler's own layout pass.

### 7.6 Reachability: forced generation, and how much of it was needed

§11 says the biggest risk is reachability, and proposes a
level-generation-only harness. NetHack already contains one: `#wizloaddes`
(`wiz_load_splua()`, wizcmds.c:376) is exactly

```c
lspo_reset_level(NULL); load_special(name); lspo_finalize_level(NULL);
```

so `C2JS_LUA_LEVELPROBE=<a.lua,b.lua,…>` drives those three calls from JS once
the game is up, and fingerprints each result. It is not a bespoke code path: it
runs the same `load_special()` the level generator runs, through the same
`load_lua()`, so the registry intercepts the script exactly as it would in play.
`tools/lua-oracle.mjs --levels=…` sets it on **both** runs, which costs no extra
module graphs — the probe's work lands in the RNG log, the screens and the load
records the oracle already compares — and adds a per-script table requiring
four things each: both sides built the level, both sides actually loaded the
`.lua` inside the probe's RNG window, the fingerprints match, and the two spent
the same number of draws.

One gotcha, found by watching a batch stop silently at script 19: **the probe
spends keys**. Building a level on top of a live game produces messages, and a
`--More--` waits for input; when the session's queue empties the harness treats
it as a normal segment end, so an unpadded run just stops probing. The oracle
pads each segment's moves with ESCs when `--levels` is given.

Then the pleasant surprise, which is that the corpus is better than §11
feared. A trace sweep over all 69 sessions shows **16 of the 49 are reached in
real play** — because four sessions (`seed0360-wizard-world-tour`,
`seed0361-archeologist-tour`, `seed0367-priest-quest-tour`,
`seed0373-barbarian-quest-tour`) and `seed4500-knight-coverage` use wizard-mode
level teleport to walk the quest branches, Sokoban, Vlad's Tower, Gehennom and
the Planes. Those 16 are byte-exact against the **C recorder**, not merely
against the JS interpreter.

### 7.7 Evidence, per script

"synthetic" = forced generation only (§7.6); "both" = that plus at least one
recorded session that generates the level in play. Every one of the 49 has
synthetic evidence at Dlvl 1 (`seed0077-rogue-chargen`), at Dlvl 10
(`gen9996-marathon-dlvl10`) and in two Monk games; the sessions listed are the
corpus ones.

| Script | .lua lines | Evidence | Corpus sessions |
|---|---|---|---|
| `Arc-goal` | 116 | both | `seed0361` |
| `Arc-loca` | 146 | both | `seed0361` |
| `Bar-fila` | 34 | both | `seed0373` |
| `Bar-filb` | 45 | both | `seed0373` |
| `Bar-goal` | 96 | synthetic | — |
| `Bar-loca` | 108 | both | `seed0373` |
| `Cav-fila` | 36 | synthetic | — |
| `Cav-filb` | 42 | synthetic | — |
| `Cav-goal` | 60 | synthetic | — |
| `Cav-loca` | 102 | synthetic | — |
| `Hea-fila` | 43 | synthetic | — |
| `Hea-filb` | 51 | synthetic | — |
| `Hea-goal` | 91 | synthetic | — |
| `Hea-loca` | 98 | synthetic | — |
| `Kni-fila` | 36 | synthetic | — |
| `Kni-filb` | 41 | synthetic | — |
| `Kni-goal` | 100 | both | `seed4500` |
| `Kni-loca` | 138 | synthetic | — |
| `Mon-loca` | 99 | synthetic | — |
| `Pri-loca` | 74 | both | `seed0367` |
| `Ran-fila` | 36 | synthetic | — |
| `Ran-filb` | 40 | synthetic | — |
| `Ran-goal` | 107 | synthetic | — |
| `Ran-loca` | 80 | synthetic | — |
| `Rog-goal` | 111 | synthetic | — |
| `Rog-loca` | 100 | synthetic | — |
| `Sam-fila` | 38 | synthetic | — |
| `Sam-filb` | 61 | synthetic | — |
| `Sam-loca` | 142 | synthetic | — |
| `Tou-fila` | 36 | synthetic | — |
| `Tou-filb` | 40 | synthetic | — |
| `Val-fila` | 41 | synthetic | — |
| `Val-filb` | 43 | synthetic | — |
| `Val-loca` | 86 | synthetic | — |
| `Wiz-goal` | 133 | synthetic | — |
| `soko2-1` | 71 | both | `seed0360`, `seed0373` |
| `soko2-2` | 73 | synthetic | — |
| `soko3-1` | 83 | both | `seed0373` |
| `soko3-2` | 75 | both | `seed0360` |
| `soko4-1` | 105 | both | `seed0360` |
| `soko4-2` | 75 | both | `seed0373` |
| `air` | 109 | both | `seed0373` |
| `earth` | 131 | synthetic | — |
| `fire` | 159 | both | `seed0373` |
| `water` | 103 | synthetic | — |
| `baalz` | 67 | both | `seed0360` |
| `minetn-6` | 103 | synthetic | — |
| `tower3` | 51 | both | `seed0360` |
| `tut-2` | 28 | synthetic | — |

**16 both, 33 synthetic-only.** The 33 are the ones behind a quest portal, a
Sokoban ascent or an Amulet that no recorded session performs; extending the
corpus to reach them is an S3 opportunity rather than an S2 gap, and the tour
sessions above show the technique (wizard-mode level teleport) already exists.

### 7.8 Oracle results

All 49, forced at Dlvl 1, in one run:

```
$ node tools/lua-oracle.mjs --levels=<all 49> sessions/seed0077-rogue-chargen.session.json
PASS  seed0077-rogue-chargen.session.json
      rng     interpreter=136267 port=136267 firstDiff=-1
      screens interpreter=33 port=33 firstDiff=-1
      forced level generation: MATCH (49 scripts)
        ok   Arc-goal.lua   fp dbfdb661/dbfdb661 rng 8693/8693
        …
        ok   tut-2.lua      fp 8cb1187a/8cb1187a rng 177/177
```

Repeated on `gen9996-marathon-dlvl10` (Dlvl 10, 150,051 draws),
`gen9005-monk-human-items` and `seed0012-monk-vault-escort` (the
`monkfoodshop()` branch) — all 49 PASS in each.

The five sessions that reach a T0 level in play PASS the plain five-check
oracle, with no probe involved:

| Session | rng | screens | fingerprints |
|---|---|---|---|
| `seed0360-wizard-world-tour` | 120639 = | 833 = | 10 loads MATCH |
| `seed0361-archeologist-tour` | 53865 = | 366 = | 11 loads MATCH |
| `seed0367-priest-quest-tour` | 50125 = | 324 = | 12 loads MATCH |
| `seed0373-barbarian-quest-tour` | 35386 = | 124 = | MATCH |
| `seed4500-knight-coverage` | 108275 = | 1814 = | 4 loads MATCH |

### 7.9 Negative controls

Four, chosen so that each of the ways this tier can be wrong is shown to fail.
Every one was reverted.

1. **A tile, in a simple script.** `soko3-1`: one boulder from (3,2) to (3,3).
   RNG identical (`3441/3441`, `firstDiff=-1`); fingerprint `65ad687b` →
   `34f1d496`. The screens also diverged here, because with the probe on the
   hero is standing on the forced level — so this control proves the fingerprint
   fires, not that it is the only thing that can.
2. **A field the player cannot see.** `Arc-goal`: the Orb of Detection's
   `spe: 5` → `spe: 4`. RNG identical, **screens identical** (`firstDiff=-1`),
   caught only by the fingerprint (`3b0e712b` → `504e522e`) — and only because
   §7.5 widened it to include `obj.spe`.
3. **A value read out of the interpreter's state.** `minetn-6`: `align[1]` →
   `align[2]`. RNG identical, screens identical, caught only by `rm.flags`
   (`ec52018d` → `91800a46`). This is the control that justifies both §7.4's
   fix and §7.5's widening at once.
4. **A `contents` closure.** No T0 script has one, so this is `oracle.lua`
   (§5's control, re-run against the new fingerprint): one statue from (2,4) to
   (2,5), on the marathon session. `rng 54924/54924 firstDiff=-1`,
   `screens 17829/17829 firstDiff=-1`, fingerprint `3351a7b` → `fa8056fe`.

Controls 1–3 are also caught independently by `--check`, which reports the
differing argument by path (`call[30] des.object.args.0.spe: 5 != 4`). Two
detectors, one mechanical and one behavioural.

---

## 8. Corpus regression

Full 69-session corpus
(`SESSION_REPLAY_TIMEOUT_MS=300000 node frozen/ps_test_runner.mjs sessions/ sessions-extra/`):

S1 (3 ports):

| Configuration | Result | Speed |
|---|---|---|
| registry inert — `C2JS_LUA_PORT=0` | **69/69** | 1013 + 0.84/turn (R² 0.723) |
| all three ports live (default), run 1 | **69/69** | 995 + 0.88/turn (R² 0.734) |
| all three ports live (default), run 2 | **69/69** | 990 + 0.83/turn (R² 0.728) |
| all three ports live (default), run 3 | **69/69** | 993 + 0.82/turn (R² 0.728) |

S2 (52 ports):

| Configuration | Result | Speed |
|---|---|---|
| registry inert — `C2JS_LUA_PORT=0`, run 1 | **69/69** | 951 + 0.80/turn (R² 0.723) |
| registry inert — `C2JS_LUA_PORT=0`, run 2 | **69/69** | 989 + 0.77/turn (R² 0.710) |
| all 52 ports live (default), run 1 | **69/69** | 926 + 0.83/turn (R² 0.763) |
| all 52 ports live (default), run 2 | **69/69** | 935 + 0.80/turn (R² 0.731) |
| all 52 ports live (default), run 3 | **69/69** | 936 + 0.76/turn (R² 0.725) |

S3 (80 ports):

| Configuration | Result | Speed |
|---|---|---|
| registry inert — `C2JS_LUA_PORT=0` | **69/69** | 992 + 0.78/turn (R² 0.711) |
| all 80 ports live (default), run 1 | **69/69** | 931 + 0.77/turn (R² 0.721) |
| all 80 ports live (default), run 2 | **69/69** | 922 + 0.78/turn (R² 0.722) |

S4 (126 ports):

| Configuration | Result | Speed |
|---|---|---|
| registry inert — `C2JS_LUA_PORT=0` | **69/69** | 1022 + 0.83/turn (R² 0.720) |
| all 126 ports live (default), run 1 | **69/69** | 1016 + 0.85/turn (R² 0.732) |
| all 126 ports live (default), run 2 | **69/69** | 993 + 0.84/turn (R² 0.724) |

S5+S6 (129 ports):

| Configuration | Result | Speed |
|---|---|---|
| registry inert — `C2JS_LUA_PORT=0` | **69/69** | 995 + 0.80/turn (R² 0.731) |
| all 129 ports live (default), run 1 | **69/69** | 886 + 0.76/turn (R² 0.736) |
| all 129 ports live (default), run 2 | **69/69** | 915 + 0.78/turn (R² 0.726) |

S7 (131 ports — every `.lua` in the corpus):

| Configuration | Result | Speed |
|---|---|---|
| registry inert — `C2JS_LUA_PORT=0` | **69/69** | 960 + 0.77/turn (R² 0.723) |
| all 131 ports live (default), run 1 | **69/69** | 832 + 0.76/turn (R² 0.727) |
| all 131 ports live (default), run 2 | **69/69** | 822 + 0.74/turn (R² 0.738) |

S7 is the second stage after S6 whose ports run in *every* session rather than
when a particular level is generated: `themerms.lua` is loaded once per game
(the Dungeons of Doom is the only branch with a themerms file) and its
generators are then called on **every ordinary level** of it, so all 69 corpus
sessions exercise it and the deep ones exercise it hundreds of times. The
corpus is therefore the primary evidence for S7, exactly as it was for S6.

S6 is the first stage whose ports run in *every* session unconditionally rather
than when a particular level is generated: `nhlib.lua` is loaded by every
`nhl_init()`, so a chargen-only session runs its port five times and
`gen9999-omnibus-all-keys` runs it hundreds. The corpus is therefore the primary
evidence for S6 in a way it was not for S2–S4, and it caught two real bugs that
nothing else did (§14.8's postscript).

Every session exercises `dungeon.lua` and `quest.lua`; `gen9996-marathon-dlvl10`
also reaches the Oracle level. It scores `RNG 54924/54924, Screen 17829/17829`
in every configuration, i.e. the ports are byte-exact against the **C recorder**,
not merely against the JS interpreter. After S2 the corpus additionally
exercises 16 T0 level scripts in real play (§7.6), after S3 16 T1 ones
(§11.6) and after S4 **24 T2 ones** (§12.6) — 56 ported level scripts are now
reached in ordinary or wizard-mode play rather than only in the probe. The
five tour sessions score `RNG 120639/120639` (`seed0360`), `53865/53865`
(`seed0361`), `50125/50125` (`seed0367`), `35386/35386` (`seed0373`) and
`108275/108275` (`seed4500`), and S4's tier is the first one whose scripts are
also reached by *ordinary* sessions — the big rooms and Mine Town turn up in
`seed0014`, `seed0030`, `seed0108`, `seed0116`, `seed0383`, `seed0399` and
`seed2600` with no wizard mode involved.

Registering 77 generated ports costs nothing measurable — small modules
imported once per replay segment, and the per-turn slope is unchanged.

Other gates: `tools/c2js/test-rnd.mjs`, `test-hacklib.mjs`, `test-setjmp.mjs`,
`test-union.mjs` PASS; `node --test test/*.test.mjs` 6/6 (posix-ere, the
`lua-port-data` transcription check and the `lua-port-scripts` call-stream
check, now **145** transcriptions — 125 generated level scripts, 19 library
functions and one whole chunk — × 11 RNG settings × up to six argument
vectors); judge-sim
`run.mjs seed8000-tourist-starter.session.json` PASS (0 mismatches, 0
out-of-scope requests); `playability.mjs --keys=hjklhjkl` engages the `xhr`
engine with `console_entries: []` — and its top line is
`It is written in the Book of Odin:`, which is `questtext.common.legacy`
arriving from the JS port through a real browser;
`node tools/strict-score.mjs --all` 0 violations.

---

## 9. Cookbook — porting a level script

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
   `node tools/lua-oracle.mjs <session>`. Require all checks green,
   *especially the fingerprint*. If no corpus session reaches the level, use
   forced generation — `node tools/lua-oracle.mjs --levels=<name>.lua <session>`
   (§7.6) — and record the evidence as synthetic in §7.7 / §11.6. Recording a reaching
   session (`tools/play-record.mjs` / `tools/generate-sessions.mjs`, into
   `sessions-extra/`) is strictly better where it is practical, because it
   compares against the C recorder rather than against the JS interpreter.
5. **Regress.** Full corpus with the port on; and once per batch, with
   `C2JS_LUA_PORT=0`, to confirm the registry is still inert when disabled.

### If the generator can take it, let it

Do not hand-type a script the generator handles — which is now anything without
a loop or a selection expression. `node tools/lua-port-gen/lua2des.mjs <in.lua>
<out.mjs>` emits one module; adding the basename to `gen-ports.mjs`'s `T0` or
`T1` list and running `node tools/lua-port-gen/gen-ports.mjs` regenerates every
port and both registry indexes. Then read the result — the generator is a
transcriber, not an authority — and let
`node --test test/lua-port-scripts.test.mjs` hold it.

The generator refuses anything outside its subset by name, so "it generated" is
itself evidence about which tier the script is in. After S4 the supported subset
is: literals, long strings, table constructors (comments included), `a.b`,
`a[k]`, `a:m(…)`, nested calls, `..`, `#`, `local`/global assignment and
re-assignment, `if … then … elseif … else … end`, numeric
`for i = a, b[, step]`, `repeat … until`, `function() … end` closures,
`function NAME(…) … end` declarations, `return`, parentheses, the arithmetic
operators `+ - * / // %`, the comparisons `== ~= < <= > >=`, `and`/`or`/`not`,
the selection operators `|`, `&`, `+` and `-`, and nhlib's
`percent`/`shuffle`/`d`/`math.random`/`hell_tweaks`.

S5 added one construct: `a:m(…)` on a *string* receiver becomes
`string.m(a, …)` rather than `selection.m(a, …)`, chosen by the receiver's
inferred type (§14.1). S7 added one more: Lua's own `type()`, which
`dat/hellfill.lua` uses to tell a bare prefab function from a
`{repeatable, contents}` table (§15.1).

The refused set is now `while`, `break`, `goto`, `^`, `<<`/`>>`, `~` (bitwise
xor and not), a mixed array/record table constructor, a numeric `for` with a
non-literal step, and a `repeat` whose `until` reads a local of the loop body —
plus the constructs S6 and S7 taught the *parser* and the `--check` interpreter
so that hand-written library and chunk ports could be proved, and which the
emitter still refuses by name: a generic `for k, v in …`, assignment through an
index or a field, multiple assignment to bare names, `...`, `table.insert`, and
Lua's own `tostring`/`table.unpack`/`_G` (§14.3, §15.6). `type` moved off that
list in S7, because `dat/hellfill.lua` needs it and the api answers it with the
same `jsType()` the interpreter uses.

`--check` runs **eleven** RNG settings after S7 (§15.1), and there is a third
entry point beside `checkPort` and `checkLibFn`: `checkChunk`, for a whole .lua
whose product is a set of functions the game calls afterwards (§15.6).

Three constructs are *accepted* but guarded rather than refused, because they
mean different things in Lua and JS and the difference is not syntactic —
`and`/`or`/`not` (truthiness), `%` (floor vs truncated modulo) and `+`/`-` (which
are set operations when their operands are selections). §12.2 explains how each
is caught; the short version is that the emitter writes the natural JS and the
`--check` interpreter implements Lua's rule, so the gap is a check failure
rather than a silent mistranslation.

`--check` compares the emitted module's call stream against the .lua's under
eight RNG settings, two of them degenerate so that *both* arms of every branch
are checked (§11.2). Both sides share one RNG counter, so it also pins how many
draws the script spends and in what order — which is the only mechanical check
there is on a `shuffle` or an `if percent(…)`.

### Gotchas found the hard way

* Do not call `nhl_init()` to make a Lua state; it spends two RNG draws.
* Do not add `luaL_openlibs` to the port state; the `lspo_*` bindings do not need
  any Lua library, and opening `math` would re-seed a PRNG nobody reads.
* `luaL_checkinteger` rejects non-integral numbers — the bridge pushes JS numbers
  as Lua integers when `Number.isInteger`, which is what every des field wants.
* A JS `throw` inside a port body must not cross a Lua C frame; `runPortedScript`
  stashes and re-throws after the pcall.
* The T0 score is computed over the level script alone. It does not follow calls
  *out* of it, so a "pure declarative" script can still reach `align`,
  `monkfoodshop()` or `nh.eckey()` in nhlib. Grep the script for free names
  before believing the tier.
* A port that needs the interpreter's `lua_State` must not run before the
  bridge's own state exists — or rather, must not care: see §7.4, and never
  add a fallback that silently uses the wrong state.
* Lua tables are 1-based. `luaList()` exists so a port can index a local list
  with the same numbers the .lua uses — and it is a *type*, not a convention,
  because `shuffle()` derives its draw count from `#list` (§11.1).
* A closure's objects are not on the floor. `contents` hangs them off
  `obj->cobj` and `inventory` off `monst->minvent`, and a fingerprint that only
  sweeps squares will not see them at all — §11.3, found by a negative control
  that passed.
* `percent(t)` costs exactly one `rn2(100)` whichever way it goes, but the two
  arms of the branch generally do not cost the same, so getting the branch
  wrong usually shows up in the RNG log a few draws later rather than at the
  branch itself.

### Cookbook — a *read-back* script

Different recipe, because the port builds a value instead of issuing calls. Use
it when the script's whole body is `<global> = { … }` and C reads that global
afterwards. Two are done (`dungeon.lua`, `quest.lua`); the remaining
candidates are `nhcore.lua` and `nhlib.lua` in S6, which are read back *and*
executable, so they need both recipes at once.

1. **Find every read.** Grep the C for `lua_getglobal` on the name, then for
   `lua_next` / `lua_getfield` / `lua_len` / `lua_gettable` around it. What you
   are looking for is a single question: *does anything walk the table with
   `lua_next`?* If yes, that table's array/hash split is observable and the
   port must reproduce it; if no, only the contents are.
2. **Find the lifetime.** Which function calls `nhl_init()`, and where is the
   matching `nhl_done()`? For both S1 scripts the answer was "the same function,
   a few lines later" — quest.lua's state does not survive the message it was
   loaded for. Do not assume a long-lived table without checking.
3. **Generate the data.**
   `node tools/lua-port-gen/lua2js.mjs <in.lua> <global> js/lua-js/data/<x>.mjs`,
   then `--check` the same command line. Add the file to
   `test/lua-port-data.test.mjs`'s `CASES` so the transcription stays checked.
4. **Write the driver** — `js/lua-js/scripts/<x>.mjs`, which is three lines:
   import the data, export `globalName`, and `setGlobal(globalName, data)`.
5. **Register it in `READBACK`**, not `PORTS`. The registry then hands the port
   a `setGlobal` bound to the interpreter's state and runs it inside
   `runProtected()`.
6. **Prove it** with `node tools/lua-oracle.mjs --readback <session>`. The
   read-back dump is the check that matters; RNG and screens will happily agree
   on a table with the wrong text in it.
7. **Add a delivery probe** if the corpus only reaches part of the table.
   `C2JS_LUA_QUESTPROBE` is the pattern: drive the real C consumer for inputs no
   session produces, and compare the *terminal byte stream*, not the sampled
   screens.

Gotchas specific to this shape:

* The port's own `lua_State` is the wrong state. Use `interpState()`.
* Never fall back silently when the state is not found — throw.
* The interpreter's state is memory-capped (1 MB sandbox). Marshalling runs
  inside `runProtected()` so `LUA_ERRMEM` unwinds through Lua, not through JS.
* Do not compare raw `lua_next` order over a hash part. It is seeded per state
  and differs run to run *for the interpreter as well*; §6.2 has the eight-way
  demonstration.

---

## 10. Staged plan for the remaining scripts

Ordered by risk-adjusted value. "Legs" = agent sessions, roughly.

| Stage | Scripts | Count | Why here | Legs |
|---|---|---|---|---|
| **S1** *pure-data* ✅ | `quest.lua`, `dungeon.lua` | 2 | **Landed — see §6.** Cost 1 leg, not 2. The new primitive turned out to be `interpState()` + `setGlobal()`, not a `setGlobalTable` on the port's own state: the table has to live in the interpreter's `lua_State`, which had to be recovered from the allocator. Traversal order was reproduced exactly where C observes it (`dungeon`'s array part) and shown to be seed-derived and unobservable where it is not (`questtext`'s hash part). Both scripts turn out to load in *every* game, so the corpus is real-play evidence for both. | 2 |
| **S2** *T0 level scripts* ✅ | 49 T0 files: `soko2-1 … soko4-2`, `air/fire/water/earth`, `baalz`, `minetn-6`, `tower3`, `tut-2`, 34 quest `*-goal/-loca/-fil*` | 49 | **Landed — see §7.** Cost 1 leg, not 6, because the transliteration is generated (§7.1) and reachability turned out to be half-solved already: forced generation (§7.6) covers everything, and the corpus's wizard-mode tour sessions reach 16 of the 49 in real play. Note the tier list here was slightly wrong: `minetn-6` is T0. (The claim that `soko1-1`/`soko1-2` have a `for` and a `math.random` was itself wrong — see the S3 row.) Three things the tier score did not predict, all in §7.3: nhlib's `align`, `monkfoodshop()` and `nh.eckey`. | 6 → 1 |
| **S3** *T1: branches, shuffles, closures* ✅ | 28 T1 files: the 10 `*-fil{a,b}` closure levels, 7 `*-strt` quest homes, `Mon/Pri/Sam-goal`, `soko1-1/2`, `minend-1/2/3`, `castle`, `juiblex`, `sanctum` | 28 | **Landed — see §11.** Cost 1 leg, not 4, for the same reason S2 did: the transliteration is generated. The tier list here was right in kind and wrong in detail — `fakewiz1/2` and `wizard2` call nhlib's `hell_tweaks()`, which is selection algebra, so they moved to S4; the six `*-strt` levels with a `for` moved with them; `soko1-1/2` moved *in* (S2's note that they have a `for` was wrong — they have one `if percent`). The stage's real work was two things §7 did not have: a `--check` that shares one RNG with the .lua so branch and shuffle draws are compared too (§11.1), and a fingerprint that follows `obj->cobj` and `monst->minvent` (§11.3), without which a whole class of this tier's content is invisible. | 4 → 1 |
| **S4** *T2: loops and selection algebra* ✅ | 46 T2 files: `minetn-1/2/3/4/5/7`, `minefill`, `medusa-1..4`, `bigrm-1..13`, `astral`, `knox`, `valley`, `orcus`, `asmodeus`, `wizard1/2/3`, `fakewiz1/2`, `tower1/2`, `Wiz-loca`, `Bar/Kni/Mon/Pri/Rog/Val-strt`, `Tou-goal/loca`, `Val-goal` | 46 | **Landed — see §12.** Cost 1 leg, not 6, for the third time in a row and for the same reason: the transliteration is generated. The row above listed 47 entries because it counted `oracle.lua`, which the PoC had already ported; the tier is 46. The bridge work the row predicted was real but smaller than feared — `lua_arith()` reaches the selection metamethods by the identical dispatch path, so the operators are two lines each. `~` never appears; `+` and `-` do, and they turned out to be the dangerous ones. Seven scripts (not nine) call `hell_tweaks()`. | 6 → 1 |
| **S5** *tutorial* ✅ | `tut-1` | 1 | **Landed — see §14.1.** Cost part of a leg. The one prediction that was wrong is "never reached in normal play": `OPTIONS=tutorial` in the rc makes `ask_do_tutorial()` skip its menu and the hero starts in `tut-1`, so it has real-play evidence for three roles. The stage's real product was two things the brief did not name — the emitter now *types* the receiver of `a:m(…)`, and the level fingerprint now sweeps the engraving chain, without which a script that is 43 engravings had no oracle at all. | 1 |
| **S6** *the libraries* ✅ | `nhlib.lua`, `nhcore.lua` | 2 | **Landed — see §14.2.** Cost 1 leg, not 3. The load-time RNG contract is the whole of the risk and it held: the port spends the same two `shuffle(align)` draws at the same seam, in every one of the dozens of `nhl_init()` calls a game makes. `pairs()` turned out not to need reproducing at all — a ported function that walks a Lua table walks it with `lua_next`, so it visits what the interpreter's `pairs` would visit, in that order, by construction (§14.4). What the row did not predict is that porting `nhlib` means leaving *callable Lua values* behind, because `themerms.lua` and `hellfill.lua` call ninety of them and are S7's; and that the stage's most valuable output is a first-ever proof of `shuffle` and `math.random` against the .lua, which four earlier stages had assumed. | 3 → 1 |
| **S7** *themed rooms* ✅ | `themerms.lua`, `hellfill.lua` | 2 | **Landed — see §15.** Cost 1 leg, not 4. `hellfill.lua` turned out to be an ordinary *generated* level script needing one new construct (Lua's `type()`); `themerms.lua` is the library-shaped port the row predicted, and its long-lived state is real but turned out to be observable only through the *load count* — a control that rebuilt the port's world per level passed every check (§15.10 control 6). What the row did not predict is that the state is **memory-capped at 1 MB** and therefore needs explicit registry-reference lifetimes, and that reading a Lua boolean out of the marshalling buffer had been wrong since the PoC (§15.4). | 4 → 1 |

Total ≈ 26 agent-legs as first estimated; S1, S2, S3, S4, S6 and S7 came in at
1 leg each instead of 2, 6, 4, 6, 3 and 4, and S5 at part of one — **7 legs
against 26**. The roadmap is complete: 131 scripts, 100 % of the file count and
100 % by bytes, and **zero** `.lua` files parsed per session (§15.9). §15.11
says what is left, which is evidence quality rather than coverage.

---

## 11. Stage S3: the 28 branch / shuffle / closure level scripts

**Landed.** The whole T1 tier is ported: the ten quest `*-fil{a,b}` levels whose
entire body is `des.room{ contents = function() … end }`, the seven `*-strt`
quest homes with their class leader's `inventory` closure, three quest `-goal`
levels that pick a spot with `math.random`, both Sokoban level-1 variants,
the three Mines end levels, `castle`, `juiblex` and `sanctum`. 2,752 lines of
Lua, 90 KB — with S1, S2 and the PoC that is **80 of 131 files and 58.9 % of the
corpus by bytes**.

The transliteration is generated, as S2's was, and the tier is small enough that
the generator work is the stage. The interesting parts are three: a `--check`
that compares the scripts' *own* RNG draws and not only their arguments; a
fingerprint that follows the two pointer chains a floor sweep cannot reach; and
a tier list that turned out to be wrong in both directions.

### 11.1 The generator, extended

`tools/lua-port-gen/lua2des.mjs` grew four constructs and one contract.

* **`if cond then … elseif … else … end`** becomes `if (…) { … } else { … }`,
  with the same statement order, the same comments and the same line breaks, so
  the branch is as diffable as everything around it.
* **`percent(n)`, `shuffle(t)`, `math.random(…)`, `d(…)`** become calls on the
  api object. `math` is now a field of it — `math.random(4, 8)` in the port
  reads exactly as it does in the .lua and draws from NetHack's rn2(), which is
  what nhlib.lua's shim does to Lua's `math.random` anyway.
* **`function() … end`** becomes an arrow function. Nothing new was needed on
  the bridge: §5 already pushes a JS closure with `lua_pushcclosure()` and
  `lspo_room()` calls it through `nhl_pcall_handle()` at the same point it would
  have called the Lua closure. `inventory = function() … end` on `des.monster`
  works the same way and is what six of the seven `*-strt` levels need.
* **`#t`** becomes `luaLen(t)`, and a `local` list the script indexes, measures
  or shuffles is built with `luaList()` so `place[1]` means the same on both
  sides. `luaList` had to become a *type* rather than a convention
  (`js/lua-js/nhlib.mjs`'s `LuaList`), because `shuffle` needs to know where
  element 1 lives: `#list` decides how many draws it spends.

The one hard-error contract is unchanged in kind and narrower in scope: the
lexer still rejects `for`, `while`, `repeat`, `and`/`or`/`not` and the
comparison and selection-algebra operators by name, so a 5.1 script that grows
one fails loudly instead of being quietly mistranslated. `if`/`function`/`#`
simply moved from the reject list to the parser.

The driver is now `tools/lua-port-gen/gen-ports.mjs` (was `gen-t0.mjs`) and
emits both tiers plus their index modules; `registry.mjs` merges `T0_PORTS` and
`T1_PORTS` into `PORTS`.

**One shared copy of nhlib.** The RNG helpers moved out of `bridge.mjs` into
`js/lua-js/nhlib.mjs`, which takes `rn2` as a parameter and imports nothing.
The bridge builds them over `js/generated/rnd.js`'s real `rn2`; the generator's
`--check` builds them over a counter. That is not tidiness — it is what makes
the next paragraph a real check rather than a comparison of two guesses.

### 11.2 `--check`, with the RNG in it

S2's `--check` ran the emitted module against a recording stub and compared the
call stream with the one the parser derived from the .lua. For a T0 script that
is complete: there is nothing else in the file. For T1 it is not, because the
script now *chooses* what to call.

So both sides now share one deterministic RNG object and one copy of nhlib.
Every `percent`, `shuffle` and `math.random` on either side draws from the same
counter, which means the comparison pins three more things at once:

* which arm of each branch was taken — they must agree;
* how many draws the script spent — a port that skips a `percent()` call, or
  shuffles a list of the wrong length, desynchronises the counter and every
  later call differs;
* the order it spent them in — swapping two `shuffle()` calls changes the
  values every subsequent list index reads.

And because the RNG is a parameter, `--check` can run settings a real game
cannot: `low` returns 0 from every `rn2`, so every `percent(t)` is true, and
`high` returns n-1, so every `percent(t)` is false. Both arms of every branch
in the tier are therefore transcription-checked, rather than whichever arm a
draw happened to select. Six xorshift settings follow, so shuffles land in
several different orders. `test/lua-port-scripts.test.mjs` runs all eight over
all 77 generated ports on every `node --test`, in about 150 ms.

A detail that matters for closures: the stub records a `des.*` call and *then*
invokes any function-valued argument, which is where `lspo_room()` and
`lspo_monster()` invoke `contents`/`inventory`. The nested calls therefore land
in the stream at the same index on both sides, and a closure's body is checked
as ordinary statements rather than as an opaque value.

### 11.3 A fingerprint that follows the chains

§7.5's fingerprint hashes every content field of every square, then every
object and every monster **on the floor**. This tier's signature construct puts
its most interesting objects nowhere near the floor:

```lua
des.object({ id = "chest", trapped = 0, locked = 1, coord = loc,
             contents = function()
                des.object("wishing");            -- inside the chest
             end })
des.monster({ id = "Lord Carnarvon", coord = {25, 10}, inventory = function()
   des.object({ id = "fedora", spe = 5 });        -- in his pack
end })
```

The wand of wishing hangs off the chest's `obj->cobj`; the fedora hangs off
`monst->minvent`. Neither is reachable from `level.objects[x][y]`, so neither
was hashed. This was found the way it should be found — a negative control that
changed the fedora's `spe` from 5 to 4 **passed all five checks** (§11.5).

`levelFingerprint()` now recurses: each floor object hashes its own
`otyp`/`spe`/`quan`/`corpsenm` and then, depth-first, everything in its `cobj`
chain; each monster hashes its species/`female`/`mpeaceful` and then everything
in its `minvent`, contents included. The offsets come from the transpiler's own
output exactly as §6.1's and §7.5's did — `delete_contents()`
(`js/generated/shk.js:1266`) walks `obj+16` with the `obj+0` link, and
`m_carrying()` (`js/generated/mthrowu.js:1313`) walks `mtmp+280` with the same
link, which gives `cobj @16`, `nobj @0` and `minvent @280`.

The chains are walked in the game's own order, which is the order the script
issued its `des.object()` calls, so the traversal is as deterministic as the
floor sweep. All fingerprint values quoted in §5, §7 and §8 predate this and no
longer reproduce.

### 11.4 The tier, and what it is not

The stage brief's tier list (§10's original S3 row) was wrong in both
directions, and the corrections are worth recording because they are how the
S4 boundary is actually drawn.

* **In.** `soko1-1` and `soko1-2` — S2's note said they have a `for` and a
  `math.random`. They do not; each has exactly one `if percent(…)` choosing
  between a bag of holding and an amulet of reflection. They are T1.
* **Out — nhlib.** `fakewiz1`, `fakewiz2`, `wizard2` (and `wizard1/3`, `orcus`,
  `asmodeus`) end with `hell_tweaks(bounds2:negate() | thing)`. `hell_tweaks`
  is an nhlib function full of `selection.grow`, `|`, `&` and its own
  `percent`/`math.random` draws — a library port, not a level port, and S4's.
* **Out — loops.** Six of the thirteen `*-strt` levels (`Bar`, `Kni`, `Mon`,
  `Pri`, `Rog`, `Val`) have a `for`. So do `Tou-goal`/`Tou-loca`. S4's.
* **In, unclaimed.** `Mon-goal`, `Pri-goal`, `Sam-goal` and `minend-2` are
  mechanically T1 (one `math.random` or a few `if percent`) and appeared in
  neither §10 row. They are here rather than left in a gap between stages.

What is left over after that is exactly S4's corrected list in §10, and it is
characterised by two things and not by "difficulty": a loop, or a selection
expression. The generator says so mechanically — it refuses both by name — so
"it generated" is evidence that a script belongs to the tier it is listed in.

### 11.5 Negative controls

Four, chosen so that each way this tier can be wrong is shown to fail, and one
of them chosen *before* it was known that it would pass. Every one was reverted
(`node tools/lua-port-gen/gen-ports.mjs` restores the tier from the .lua).

1. **A `percent` threshold, probability-invisibly wrong.** `soko1-1`:
   `percent(75)` → `percent(25)`. No single game can tell 75 % from 25 %, and
   the roll itself costs one `rn2(100)` either way — but the branch it selects
   builds a different object, and creating an amulet of reflection instead of a
   bag of holding spends ten more draws. On `seed0367-priest-quest-tour`:
   `rng 50125/50135 firstDiff=42773`, five draws into `soko1-1`'s own window;
   screens diverge at 308; fingerprint `7eadedc9` → `bd099ec0`. **All three
   fire**, and `--check` reports it too
   (`rng=3 call[64] des.object.args.0.id: "bag of holding" != "amulet of reflection"`).
2. **A branch whose arms spend different numbers of draws.** `minend-2`: the
   outer `if (percent(50))` of its nested pair inverted to `if (!percent(50))`.
   The outer roll still costs its draw; the *inner* `percent(50)` is spent only
   when the branch is taken. Both runs end with the same total draw count
   (108275) and the log still diverges — on `seed4500-knight-coverage`,
   `rng firstDiff=66581`, five draws into `minend-2`'s window at 66576, with
   the fingerprint `fea812ac` → `c9ac0638`. This is the control the brief asked
   for: the RNG *sequence*, not its length, is what catches a wrong branch.
3. **Draw order inside a script.** `castle`: its two `shuffle()` calls swapped,
   so the same twelve draws happen in the other order and every `object[n]` and
   `monster[n]` reads a different value. On `seed0360-wizard-world-tour`,
   `rng firstDiff=8710` — the exact index at which `castle.lua` was loaded, i.e.
   its very first draw. `--check` also catches it
   (`rng=1 call[128] des.monster.args.0: "N" != "Z"`).
4. **A field inside a closure, invisible to play — the one that failed.**
   `Arc-strt`: the fedora in Lord Carnarvon's `inventory` closure, `spe: 5` →
   `spe: 4`. Against the §7.5 fingerprint this **PASSED**: `rng 53865/53865
   firstDiff=-1`, `screens 366/366 firstDiff=-1`, fingerprint MATCH. The object
   is in a monster's pack and nothing hashed it. With §11.3's widening the same
   control fails on the fingerprint alone — RNG and screens still identical —
   which is the §5 statue control's exact shape, one pointer chain further in.

Control 4 is the reason this section exists in the order it does. A negative
control that passes is not a failed experiment; it is the only kind of evidence
that finds a hole in the oracle rather than in the port.

### 11.6 Evidence, per script

"synthetic" = forced generation only (§7.6); "both" = that plus at least one
recorded session that generates the level in play. Every one of the 28 has
synthetic evidence at four depths and roles: Dlvl 1
(`seed0077-rogue-chargen`), Dlvl 10 (`gen9996-marathon-dlvl10`), a Monk game
(`gen9005-monk-human-items`) and a Valkyrie one (`gen9011-valkyrie-dwarf-items`).

| Script | .lua lines | What it adds | Evidence | Corpus sessions |
|---|---|---|---|---|
| `Arc-fila` | 59 | 6 closures | both | `seed0361` |
| `Arc-filb` | 59 | 6 closures | both | `seed0361` |
| `Mon-fila` | 61 | 6 closures | synthetic | — |
| `Mon-filb` | 60 | 6 closures | synthetic | — |
| `Pri-fila` | 55 | 6 closures | both | `seed0367` |
| `Pri-filb` | 62 | 6 closures | both | `seed0367` |
| `Rog-fila` | 64 | 6 closures | synthetic | — |
| `Rog-filb` | 64 | 6 closures | synthetic | — |
| `Wiz-fila` | 59 | 6 closures | both | `seed0360` |
| `Wiz-filb` | 58 | 6 closures | both | `seed0360` |
| `Arc-strt` | 116 | `inventory` closure | both | `seed0361` |
| `Cav-strt` | 94 | `inventory` closure | synthetic | — |
| `Hea-strt` | 109 | `inventory` closure | synthetic | — |
| `Ran-strt` | 101 | `inventory` closure | synthetic | — |
| `Sam-strt` | 98 | `inventory` closure | synthetic | — |
| `Tou-strt` | 134 | `inventory` closure | synthetic | — |
| `Wiz-strt` | 107 | `inventory` closure | both | `seed0360` |
| `Mon-goal` | 75 | `math.random`, `#t` | synthetic | — |
| `Pri-goal` | 84 | `math.random`, `#t` | both | `seed0367` |
| `Sam-goal` | 111 | 4 × `math.random`, redeclared locals | synthetic | — |
| `soko1-1` | 112 | `if percent`, selection | both | `seed0360`, `seed0361`, `seed0367` |
| `soko1-2` | 113 | `if percent`, selection | both | `seed0373` |
| `minend-1` | 119 | `shuffle` over 7 coords | both | `seed0361`, `seed0367` |
| `minend-2` | 159 | 5 × `if percent`, one nested | both | `seed0360`, `seed4500` |
| `minend-3` | 107 | `shuffle` over 3 coords | synthetic | — |
| `castle` | 257 | 2 shuffles, selection, `contents` | both | `seed0360` |
| `juiblex` | 122 | `shuffle`, selection | both | `seed0360` |
| `sanctum` | 133 | `contents` inside a region | both | `seed0360`, `seed4500` |

**16 both, 12 synthetic-only.** The 12 are the Monk, Rogue, Caveman, Healer,
Ranger, Samurai and Tourist quest branches, which no recorded session enters —
the same gap §7.7 describes, and the same fix: one more wizard-mode tour
session per role upgrades several scripts at once.

### 11.7 Oracle results

All 28, forced at Dlvl 1:

```
$ node tools/lua-oracle.mjs --levels=<all 28> sessions/seed0077-rogue-chargen.session.json
PASS  seed0077-rogue-chargen.session.json
      rng     interpreter=74274 port=74274 firstDiff=-1
      screens interpreter=4033 port=4033 firstDiff=-1
      forced level generation: MATCH (28 scripts)
        ok   Arc-fila.lua   fp 8d73982d/8d73982d rng 3744/3744
        …
        ok   castle.lua     fp df6f6597/df6f6597 rng 8701/8701
        ok   juiblex.lua    fp 38aba35b/38aba35b rng 2466/2466
        ok   sanctum.lua    fp e218863/e218863 rng 6892/6892
```

Repeated on `gen9996-marathon-dlvl10` (Dlvl 10, 107,098 draws),
`gen9005-monk-human-items` and `gen9011-valkyrie-dwarf-items` — all 28 PASS in
each, 112 forced generations in total.

The five sessions that reach a T1 level in play PASS the plain five-check
oracle, with no probe involved:

| Session | rng | screens | T1 scripts reached |
|---|---|---|---|
| `seed0360-wizard-world-tour` | 120639 = | 833 = | `castle`, `sanctum`, `juiblex`, `minend-2`, `soko1-1`, `Wiz-strt`, `Wiz-fila`, `Wiz-filb` |
| `seed0361-archeologist-tour` | 53865 = | 366 = | `Arc-strt`, `Arc-fila`, `Arc-filb`, `minend-1`, `soko1-1` |
| `seed0367-priest-quest-tour` | 50125 = | 324 = | `Pri-goal`, `Pri-fila`, `Pri-filb`, `minend-1`, `soko1-1` |
| `seed0373-barbarian-quest-tour` | 35386 = | 124 = | `soko1-2` |
| `seed4500-knight-coverage` | 108275 = | 1814 = | `minend-2`, `sanctum` |

S2's tiers were re-run under the widened fingerprint and are unaffected: all 49
T0 scripts still MATCH forced at Dlvl 1, and `--readback --questprobe` on
`seed0077-rogue-chargen` still reports `read-back table: MATCH` with the
`lua_next` order over `dungeon` matching and the quest text byte-identical.

### What S4 needs

> **Answered in §12.** All five bullets landed; two of the
> predictions were wrong in detail and §12.4 records the corrections.

* **The bridge's selection handles, for real.** `LuaValue` round-trips a
  `selection.*` result through the Lua registry and S3 exercises it properly
  for the first time (`castle`, `juiblex`, `soko1-*` build a selection and then
  `selection.set` into it, and `selection.rndcoord` hands a coord table back).
  What is still untouched is the *algebra*: `|`, `&`, `~` and `-` are
  metamethods (`l_selection_meta[]`, nhlsel.c:1009) and a port has to spell out
  the function they dispatch to. `:iterate(closure)` is the other one.
* **`hell_tweaks()`, i.e. a piece of nhlib.** Nine S4 scripts end by calling it.
  It is 60 lines of selection algebra with its own `percent` and `math.random`
  draws, and it is not a level script, so it wants a home — probably
  `js/lua-js/nhlib-fns.mjs` next to the RNG helpers, ported once and shared,
  with its own `--check` coverage. Porting it early is what unblocks the whole
  Gehennom group.
* **Loops in the generator.** Numeric `for i = a, b[, step]` is the only loop
  form the corpus uses outside the libraries (`while` appears zero times,
  `repeat` twice, both in libraries). Emitting it is easy; the `--check`
  interpreter needs the matching case, and the shared-RNG contract of §11.2
  then covers loop bodies for free.
* **Nothing new on reachability.** `--levels=` takes any script; the Mines and
  big-room levels S4 owns are corpus-reachable in ordinary play, which makes it
  better-evidenced than S3 before it starts.
* **A budget note.** The oracle allocates two module graphs per session and
  never releases them, so a `--levels` sweep over a whole tier should stay
  under about ten sessions per process (`--max-old-space-size=8192` was used
  throughout this stage).

---

## 12. Stage S4: the 46 loop / selection-algebra level scripts

**Landed.** The whole T2 tier is ported: the seven Mines levels (`minefill` and
six Mine Town variants), the thirteen big rooms, Medusa's four islands, the
whole of Gehennom that is not already done (`asmodeus`, `orcus`, `wizard1/2/3`,
`fakewiz1/2`, `valley`), Vlad's Tower's lower two floors, Fort Ludios, the
Astral Plane, and the ten quest levels S3 left behind. 4,921 lines of Lua,
181 KB — with S1, S2, S3 and the PoC that is **126 of 131 files and 88.4 % of
the corpus by bytes**. Five files remain: `tut-1` (S5), `nhlib`/`nhcore` (S6),
`themerms`/`hellfill` (S7).

S3 said this tier is characterised by two things and not by "difficulty": a
loop, or a selection expression. That held. What it did not predict is that the
selection expressions include `+` and `-`, which are also ordinary arithmetic —
and that turned out to be the only place in four stages where the generator
could have produced a *silently wrong* port rather than a loud failure.

### 12.1 Selection algebra: what the VM actually invokes

A selection is C userdata with a metatable, so `a | b` is not an operation the
VM performs. `OP_BOR`'s fast path is `tointegerns` on both operands; userdata
fails it, and the opcode falls through to

```c
luaT_trybinTM(L, v1, v2, ra, TM_BAND + (GET_OPCODE(i) - OP_BAND))
```

which for `|` is `TM_BOR`, which `nhlsel.c:1009` binds to `l_selection_or`.
That function is `staticfn`, so it is not exported from the transpiled module
and a port cannot call it directly — which is the right outcome, because
calling it directly would skip the dispatch rather than reproduce it.

The reproduction is `lua_arith()`. Its path is

```
lua_arith(L, LUA_OPBOR)
  -> luaO_arith(L, op, p1, p2, res)
       -> luaO_rawarith(...)                       fails: userdata is not an integer
       -> luaT_trybinTM(L, p1, p2, res, TM_ADD + (LUA_OPBOR - LUA_OPADD))
                                                   == TM_BOR
```

i.e. the identical metamethod, found in the identical table, called with the
identical two arguments through `luaT_callTMres` → `luaD_callnoyield`. The only
difference from `OP_BOR` is that the result lands on the stack top instead of
in a register, and both are stack slots. So `bridge.mjs` pushes the two
operands, calls `lua_arith`, and takes the result:

| Lua | metamethod | C function | bridge |
|---|---|---|---|
| `a \| b` | `__bor` | `l_selection_or` | `selection.bor(a, b)` |
| `a & b` | `__band` | `l_selection_and` | `selection.band(a, b)` |
| `a + b` | `__add` | `l_selection_or` (aliased) | `selection.add(a, b)` |
| `a - b` | `__sub` | `l_selection_sub` | `selection.sub(a, b)` |

`+` and `|` really are the same C function — nhlsel.c says so in a comment —
but the port keeps them apart so it issues the dispatch the .lua wrote.
`~` (i.e. `__bnot`/`__unm`, both `l_selection_not`) appears nowhere in the
corpus: every negation is spelled `:negate()`, which is an ordinary method
call and needed nothing new. The census that established this is in §12.4.

**`:iterate(closure)` needed only a callback fix.** `l_selection_iterate`
pushes the function and two integers and calls it through `nhl_pcall_handle`,
exactly as `lspo_room` calls `contents` — but with *numbers* as arguments
rather than the mkroom table. `wrapCallback` now dispatches on what is actually
on the stack rather than on the JS function's arity, so one wrapper serves both
shapes.

**Reading a selection's answer back.** Four of the 24 methods return something
other than a selection: `numpoints()` and `get()` return integers, `rndcoord()`
returns a fresh `{x, y}` table and `bounds()` a fresh `{lx, ly, hx, hy}` one,
`describe_size()` a string. `hell_tweaks()` does arithmetic on `numpoints()`,
the Gehennom levels do arithmetic on `bounds()`, and six scripts pass
`rndcoord()`'s table straight back as a `coord` argument. So `callTable1` now
inspects the result's `lua_type` and hands back a JS number, boolean, string,
plain object or opaque `LuaValue` accordingly. Re-marshalling the coord table
is exact rather than merely adequate: it is freshly built by the C function,
nothing else holds a reference to it, and every C consumer reads `x` and `y`
by name (`sp_lev.c`'s `get_coord`) or by integer index.

### 12.2 The one place the generator could have lied

Every earlier stage's contract was "anything outside the subset is a hard
error", and that is what makes a generator safe to use at all. `+` and `-`
break it, because they are *in* the subset for numbers and mean something
completely different for selections:

```lua
validtraps = validtraps - (selection.area(15,03,20,05) + selection.area(62,03,71,04))
local bounds2 = selection.fillrect(bnds.lx, bnds.ly + 1, bnds.hx - 2, bnds.hy - 1)
```

The first is set difference and union; the second, two files away, is ordinary
subtraction on integers out of a bounds table. Emitted as JS `-`, the first
produces `NaN`, and `NaN` reaches `lspo_trap` as a coordinate. There is no
syntactic difference to key on.

Two mechanisms now stand between that and a wrong port, and it matters that
they are independent:

* **The emitter infers.** `isSelectionExpr()` answers "is this a selection?"
  syntactically — what `selection.*` returns (minus the five scalar methods),
  what a `:method()` on one returns, what `des.map()` returns, what an operator
  between two of them returns, and what a name currently in scope is bound to.
  If the two operands of `+`/`-` disagree, it is a hard error rather than a
  guess.
* **The check dispatches like Lua.** `--check`'s interpreter no longer JS-adds
  two stub objects; it routes `+`/`-` on a non-number to the same
  `selection.add`/`selection.sub` the port would call. So a port that emitted
  plain arithmetic diverges from the .lua's call stream instead of quietly
  agreeing with it — which is precisely what happened before this change, and
  why the bug reached the oracle instead of the check.

The same "emitter writes JS, interpreter implements Lua" split now covers two
more gaps the tier opened:

* **Truthiness.** Lua's only false values are `false` and `nil`; JS also has 0
  and `""`. `and`/`or`/`not` emit `&&`/`||`/`!`, `evalNode` uses Lua's rule, and
  the emitter refuses outright when the *left* operand of `and`/`or` is a
  literal `0` or `""` — only the left one can expose the difference, which is
  why `dat/minetn-1.lua`'s `(i == 1) and 3 or 0` is fine and needed no
  exception.
* **`%`.** Lua's is floor-modulo, JS's truncates; they differ only on
  negatives. The emitter writes `a % b`, the interpreter computes Lua's.
  `dat/bigrm-13.lua` is the only script that cares and all its operands are
  non-negative — but a 5.1 that changed that would now fail the check rather
  than shift every pillar.

### 12.3 `hell_tweaks()` as a generated library port

Seven Gehennom levels end with `hell_tweaks(protected)`. It is 60 lines of
`nhlib.lua` — selection algebra, a `repeat … until`, and its own `percent()`
and `math.random()` draws keyed off `u.depth` — so it is a library port, not a
level port, and it blocks all seven.

§11 guessed it would be hand-written next to the RNG helpers. It is generated
instead, by the same `lua2des.mjs` that emits the level scripts, into
`js/lua-js/nhlib-fns.mjs`. `extractFunction()` takes it out of `nhlib.lua` by
line range — the opening `function NAME(` and the closing `end` are both at
column 0, throughout that file — because the *rest* of `nhlib.lua` is well
outside the subset (varargs, `pairs`, `string.format`, `error`) and parsing it
would mean supporting all of that for one function.

Generating it buys the thing that matters: `checkLibFn()` gives it the same
call-stream comparison every level script gets, under the same eight RNG
settings, with the .lua side interpreted out of `nhlib.lua` and the JS side
imported from the generated module. A level script's own `--check` then calls
*through* the library port on the same shared counter, so the seven Gehennom
scripts are checked end to end.

Three things it needed from the bridge that no level script did:

* `u.depth` — `nhl_meta_u_index`'s "depth" case, i.e. `depth(&u.uz)`, exposed
  as a getter so a port that never mentions `u` never reads it;
* `nhc.COLNO` / `nhc.ROWNO` — two entries of `nhl_consts[]`;
* `repeat … until` in the generator, which emits `do { … } while (!(…))` and
  hard-errors if the `until` expression reads a local of the loop body (Lua's
  scope rule there is not JS's; `hell_tweaks` keeps its counters outside, and
  nothing else in the corpus uses `repeat` at all).

The `--check` stub had to grow with it. `numpoints()` has to return a *number*
that grows, or the `until (rpts > reqpts or rivertries > 7)` loop is not a loop;
`bounds()` has to return four real integers, or the Gehennom levels' `bnds.ly +
1` is `undefined + 1`. Each is a pure function of how many times it has been
called, so both sides of the comparison see the same value, and `u.depth` varies
across the eight settings so the two depth-dependent thresholds are exercised at
more than one depth.

### 12.4 The tier, and three corrections to §10/§11

* **The count.** §10's S4 row listed 47 scripts because it counted `oracle.lua`,
  which the PoC had already ported. The tier is 46, and 46 + 80 = 126.
* **`hell_tweaks` is seven scripts, not nine.** §11.4 and §11's "What S4 needs"
  both say nine. The callers are `asmodeus`, `fakewiz1`, `fakewiz2`, `orcus`,
  `wizard1`, `wizard2`, `wizard3`. `valley` and `baalz` are Gehennom levels that
  do not call it.
* **`~` is never used; `+` and `-` are.** §11 named `|`, `&`, `~` and `-` as the
  operators to expect and put `~` first among the unknowns. Across all 131 files
  the actual tally is 19 `|`, 2 `&`, 2 `-`, 1 `+`, and zero `~` — every negation
  is `:negate()`. The two `-` sites and the one `+` site are all in
  `Tou-goal`/`Tou-loca`, and they are the ones that mattered (§12.2).

Two smaller surprises, both found by the generator refusing to parse:

* `dat/bigrm-8.lua` and `dat/bigrm-10.lua` write `end;` — Lua's empty
  statement, which the parser had never met.
* `dat/bigrm-13.lua` puts a numbering comment above each of its eight pillar
  filters, *inside* the table constructor. Table entries had never carried
  comments; they do now, so the emitted `luaList(…)` reads the way the .lua
  does.

And one that only the runtime found: `des.map()` returns the selection of the
squares it wrote, and `local asmo1 = des.map{…}` in each of the seven Gehennom
scripts uses it. The bridge discarded every `des.*` result, so `asmo1` was
`undefined` and `l_selection_or` was handed nil. `lspo_map` and `lspo_object`
are the only two of the 34 `des` bindings that push a result; only `map`'s is
read anywhere in the corpus, so only `map` keeps it. (The two scripts that read
`des.object`'s result are `themerms.lua` and `hellfill.lua` — S7's.)

### 12.5 A fingerprint that reads the whole struct

§7.5 widened the fingerprint from `rm.typ` to every content field of `struct
rm` plus four object and three monster fields; §11.3 widened it again to the
`obj->cobj` and `monst->minvent` chains. Both lists were enumerated by hand from
the accessors the generated code happened to use, and both turned out short.
S4's negative control found the next hole, in the way the brief predicted:

> Renaming one of Dracula's brides in `dat/tower1.lua` — `Countess` →
> `Duchess` — **passed all five checks.** `rng 3753/3753 firstDiff=-1`,
> `screens 4033/4033 firstDiff=-1`, fingerprint MATCH.

A name is not in `struct monst` at all. It hangs off `monst->mextra->mgivenname`,
one pointer chain further out than `minvent`, and the fingerprint never followed
it.

So this stage stops sampling. The offsets now come from the transpiler's own
layout pass — `Emitter.layoutOf()` in `tools/c2js/emit.mjs`, the same function
that decided every offset in `js/generated` — which confirms the seven already
in use and supplies the rest:

* **`struct obj`, 40 fields.** Including the `cursed`…`named_how` block of 28
  consecutive 32-bit slots, which is where `des.object`'s `buc`, `locked`,
  `trapped` and `eroded` land, plus `oextra->oname`.
* **`struct monst`, 50 fields.** Including the `female`…`mgenmklev` block of 35
  slots (`peaceful`, `asleep`), `m_lev` (`m_lev_adj`), `malign` (`align`),
  `mappearance`/`m_ap_type` (`appear_as`), `mstrategy` (`waiting`), plus
  `mextra->mgivenname`.
* **`struct trap`, the whole `gf.ftrap` chain** — which was not swept at all.
  `des.trap` is 794 uses across 117 files, and a trap changes neither the square
  nor any object, so a wrong trap type at the right place was invisible unless
  it happened to cost different randomness. `js/generated/trap.js`'s `t_at()`
  reads the head as `cptr.ldPtr(gf)` and walks it with the same offset-0 link,
  which independently confirms `layoutOf('trap')`.

Still excluded, and for the same reasons as before: pointers (the two sides
allocate different amounts by construction), the `o_id`/`m_id` counters, and
`struct rm`'s `glyph`/`seenv`, which are display state rather than what the
script built. Every fingerprint value quoted in §5, §7 and §11 predates this
and no longer reproduces.

### 12.6 Evidence, per script

"synthetic" = forced generation only (§7.6); "both" = that plus at least one
recorded session that generates the level in play. Every one of the 46 has
synthetic evidence at **five** depth/role settings: Dlvl 1
(`seed0077-rogue-chargen`), Dlvl 10 (`gen9996-marathon-dlvl10`), a Monk game
(`gen9005-monk-human-items`), a Valkyrie one (`gen9011-valkyrie-dwarf-items`)
and deep in the wizard world tour (`seed0360-wizard-world-tour`), which is the
setting that puts `u.depth` in Gehennom range and makes `hell_tweaks()`'s
`percent(20 + u.depth)` branch fire routinely. 230 forced generations in all.

| Script | .lua lines | What it adds | Evidence | Corpus sessions |
|---|---|---|---|---|
| `Bar-strt` | 100 | `&`, `for`, `rndcoord` | both | `seed0373` |
| `Kni-strt` | 110 | `for` over `nh.rn2`, nested closure | synthetic | — |
| `Mon-strt` | 109 | 3 `for`, `rndcoord` | synthetic | — |
| `Pri-strt` | 103 | 2 `for`, `rndcoord` | both | `seed0367` |
| `Rog-strt` | 167 | 2 `for` over `math.random` | synthetic | — |
| `Val-strt` | 101 | `for`, 3 × `|`, `:clone():grow()` | synthetic | — |
| `Tou-goal` | 160 | `-` on selections | synthetic | — |
| `Tou-loca` | 154 | `-` and `+` on selections | synthetic | — |
| `Val-goal` | 105 | `for` | synthetic | — |
| `Wiz-loca` | 152 | 5 closures | both | `seed0360` |
| `bigrm-1` | 82 | 2 × `|`, `%`, `elseif` chain | synthetic | — |
| `bigrm-2` | 72 | 4-term `|` chain, `~= nil` | both | `seed0116` |
| `bigrm-3` | 84 | `for` | both | `seed0367` |
| `bigrm-4` | 60 | `~=` on a string | both | `seed0360` |
| `bigrm-5` | 55 | `and`/`or` value idiom | synthetic | — |
| `bigrm-6` | 49 | `for` | synthetic | — |
| `bigrm-7` | 53 | `for` | both | `seed0361`, `seed0399` |
| `bigrm-8` | 54 | `end;` | both | `seed0108`, `seed0373` |
| `bigrm-9` | 53 | `for` | both | `seed2600` |
| `bigrm-10` | 62 | `end;` | synthetic | — |
| `bigrm-11` | 40 | 2 named functions, `|`, `:iterate` | synthetic | — |
| `bigrm-12` | 86 | `for` | both | `seed0383` |
| `bigrm-13` | 83 | 8 predicate closures, `//`, `%`, `/`, nested `for` | synthetic | — |
| `medusa-1` | 124 | `for` | both | `seed0367` |
| `medusa-2` | 130 | `for` | synthetic | — |
| `medusa-3` | 139 | 2 `for` | both | `seed0360`, `seed4500` |
| `medusa-4` | 153 | 4 `for` | synthetic | — |
| `minefill` | 52 | 4 `for` over `math.random`, `and`/`or` | both | `seed0014`, `seed0030`, `seed4500` |
| `minetn-1` | 151 | `&`, 4 `for`, `(i == 1) and 3 or 0` | synthetic | — |
| `minetn-2` | 183 | 22 closures | both | `seed0367` |
| `minetn-3` | 151 | 21 closures | both | `seed0014` |
| `minetn-4` | 134 | 17 closures | both | `seed4500` |
| `minetn-5` | 138 | 19 selections | both | `seed0360` |
| `minetn-7` | 199 | 23 closures | synthetic | — |
| `asmodeus` | 97 | `des.map` result, `bounds()`, `|`, `hell_tweaks` | both | `seed0360` |
| `fakewiz1` | 45 | `|`, `hell_tweaks` | synthetic | — |
| `fakewiz2` | 45 | `|`, `hell_tweaks` | synthetic | — |
| `orcus` | 160 | `|`, `hell_tweaks`, `math.random` branch | both | `seed0360` |
| `wizard1` | 103 | `|`, `hell_tweaks`, morgue closure | both | `seed0360` |
| `wizard2` | 63 | `|`, `hell_tweaks` | both | `seed0360` |
| `wizard3` | 91 | `|`, `hell_tweaks` | synthetic | — |
| `tower1` | 75 | `nh.is_genocided`, `not`, nil list | both | `seed0360`, `seed0361`, `seed0367`, `seed0373` |
| `tower2` | 63 | 2 closures | both | `seed0360` |
| `astral` | 188 | 2 `for`, `i == 1` | synthetic | — |
| `knox` | 168 | named function, `:iterate`, `des.gold` | synthetic | — |
| `valley` | 175 | 6 selections | both | `seed0360`, `seed4500` |

**24 both, 22 synthetic-only** — the best ratio of any stage, and the first
where the "both" column is not carried entirely by wizard-mode tours: the big
rooms and Mine Town turn up in ordinary play in `seed0014`, `seed0030`,
`seed0108`, `seed0116`, `seed0383`, `seed0399` and `seed2600`. The 22 that are
synthetic-only are the Monk/Rogue/Valkyrie/Tourist/Knight quest branches, three
big-room variants no session happened to roll, Fort Ludios (behind a magic
portal), the Astral Plane, and the three Gehennom levels `seed0360` did not
walk through.

### 12.7 Oracle results

All 46, forced at Dlvl 1:

```
$ node tools/lua-oracle.mjs --levels=<all 46> sessions/seed0077-rogue-chargen.session.json
PASS  seed0077-rogue-chargen.session.json
      forced level generation: MATCH (46 scripts)
        ok   Bar-strt.lua   fp bd6aa63f/bd6aa63f rng 1585/1585
        …
        ok   asmodeus.lua   fp e373ff68/e373ff68 rng 3782/3782
        ok   knox.lua       fp b4ebafb7/b4ebafb7 rng 6521/6521
        ok   valley.lua     fp 32932635/32932635 rng 4973/4973
```

Repeated at Dlvl 10 (`gen9996-marathon-dlvl10`), in a Monk game
(`gen9005-monk-human-items`), a Valkyrie one (`gen9011-valkyrie-dwarf-items`)
and deep in `seed0360-wizard-world-tour` — all 46 PASS in each, 230 forced
generations in total. (The tier is swept in three batches of ≤16 per process;
§11's budget note still applies.)

The five sessions that reach a T2 level in play PASS the plain five-check
oracle, with no probe involved:

| Session | rng | screens | T2 scripts reached |
|---|---|---|---|
| `seed0360-wizard-world-tour` | 120639 = | 833 = | `asmodeus`, `orcus`, `wizard1`, `wizard2`, `valley`, `medusa-3`, `minetn-5`, `bigrm-4`, `tower1`, `tower2`, `Wiz-loca` |
| `seed0361-archeologist-tour` | 53865 = | 366 = | `bigrm-7`, `tower1` |
| `seed0367-priest-quest-tour` | 50125 = | 324 = | `Pri-strt`, `medusa-1`, `minetn-2`, `bigrm-3`, `tower1` |
| `seed0373-barbarian-quest-tour` | 35386 = | 124 = | `Bar-strt`, `bigrm-8`, `tower1` |
| `seed4500-knight-coverage` | 108275 = | 1814 = | `valley`, `medusa-3`, `minefill`, `minetn-4` |

S1–S3's tiers were re-run under the widened fingerprint and are unaffected: all
80 prior ports still MATCH forced at Dlvl 1 (four batches of ≤20), the plain
oracle on `gen9996-marathon-dlvl10` still reports
`rng 54924/54924, screens 17829/17829`, and `--readback --questprobe` on
`seed0077-rogue-chargen` still reports `read-back table: MATCH` with the
`lua_next` order over `dungeon` matching and the quest text byte-identical
(`23882 terminal bytes, firstDiff=-1`).

### 12.8 Negative controls

Seven, of which two are the ones the brief asked for and one is the one that
found the hole in §12.5. Every one was reverted
(`node tools/lua-port-gen/gen-ports.mjs` restores every tier and the library
port from the .lua).

1. **Selection algebra, same draw count.** `minetn-1`: `near_temple`'s
   `selection.band(…)` → `selection.bor(…)`, so the orc shamans are placed from
   a union instead of an intersection. The script spends **the same 3,232
   draws** either way — `selection_rndcoord` costs one roll whatever the
   region's size — and the region is different. `rng 6531/6531` in total with
   `firstDiff=5726`: the *sequence* diverges where the shamans land, not the
   count. Screens identical (`firstDiff=-1`). Fingerprint `b77e3cbd` →
   `9d5b06a2`. `--check` reports it mechanically too
   (`rng=low call[71] selection.band.fn: "selection.band" != "selection.bor"`).
   **Three detectors fire: the RNG sequence, the fingerprint, and `--check`.**
2. **`hell_tweaks`, same draw count.** `nhlib-fns.mjs`: the `"west"` and
   `"north"` pool-growing lines swapped. Both cost one
   `selection.set(selection.new())` — a random point each — so the draw sequence
   inside the library is untouched and only which point grows which way
   changes. On `seed0360-wizard-world-tour`, `orcus.lua` spends the same
   **3,209** draws and its fingerprint moves `40b0fbe5` → `f8d303d0`; the
   global RNG log then diverges downstream at 46260 because a different lava
   layout changes the rest of the game. `asmodeus` and `wizard1` **pass** in
   the same run, because at their depth the `percent(20 + u.depth)` pool branch
   did not fire — which is the control being honest about what it tests.
   `checkLibFn` catches it directly:
   `hell_tweaks rng=low call[11] selection.grow.args.1: "west" != "north"`.
3. **A numeric `for` limit re-evaluated instead of hoisted.** `minefill`:
   `for (let i = 1, iEnd = math.random(2, 5); …)` → `for (let i = 1; i <=
   math.random(2, 5); i++)`. Lua evaluates a numeric for's limit exactly once;
   re-evaluating spends a draw per iteration. `rng 7974/6242 firstDiff=5032`,
   fingerprint `1e08311e` → `b3acd7d4`, and `--check` catches it as a call-count
   difference (`rng=1 call count: lua=32 js=34`). This is the control that
   justifies `renderFor`'s hoist.
4. **A field invisible to play, inside a `contents` closure.** `tower1`: the
   wax candles in the chest become tallow candles. `rng 3753/3753
   firstDiff=-1`, `screens 4033/4033 firstDiff=-1` — **caught only by the
   fingerprint** (`5941ad55` → `ece87fb8`), and only because §11.3 follows
   `obj->cobj`. The §5 statue control's exact shape, one tier on.
5. **A monster's name — the one that failed.** `tower1`: `Countess` →
   `Duchess`. Against the §11.3 fingerprint this **PASSED** on all five checks.
   A name lives in `monst->mextra->mgivenname`, which nothing hashed. With
   §12.5's widening the same control fails on the fingerprint alone
   (`da965e2a` → `6de7619e`), RNG and screens still identical. This is S3's
   control 4 repeating itself one pointer chain further out, and it is why
   §12.5 stops enumerating fields by hand.
6. **A trap type.** `knox`: the two arms of `treasure_spot`'s inner `if`
   swapped, so spiked pits and land mines trade places. `rng 10141/10003
   firstDiff=3223` — the two trap types cost different randomness, so this one
   fires on the RNG log as well as the fingerprint (`304b29d6` → `b41733e5`).
   It does *not* prove the trap chain is hashed, which is why there is a
   seventh.
7. **A trap field with no RNG cost at all.** `tut-2` (a T0 script, reused
   because it is the only `des.trap{ seen = … }` in the corpus): `seen: true` →
   `seen: false`. Nothing about the level's squares, objects or monsters
   changes and not one draw differs — `rng 3534/3534 firstDiff=-1`. Before
   §12.5 the fingerprint could not have seen it; now `3bf13601` → `795b3c0`.
   That is the proof that the `gf.ftrap` sweep is real rather than decorative.

Controls 1, 2 and 3 are also caught independently by `--check`, which is a
source-level comparison needing no game at all; 4, 5 and 7 are caught by the
fingerprint alone. Two detectors, one mechanical and one behavioural, and the
stage's two new bugs (§12.4's `des.map` result and a stack-index slip in the
bridge's table reader) were both found by the *behavioural* one — the
mechanical check passed them, because the stub api cannot know what
`lua_getfield` does with a relative index.

### 12.9 Two bugs, and one design fix

Worth recording because they are the shape of thing this tier produces:

* **`readNumTable` adjusted a relative stack index it should not have.**
  `lua_getfield(L, idx, k)` reads the table at `idx` and *then* pushes the
  result, so when the table is on top the index is `-1` for every field. The
  code adjusted to `-2` as if the push had already happened, read six absent
  fields, and returned `{}` — so every `rndcoord()` came back empty and
  `des.trap("dart", {})` reached `get_coord` as "Not a coordinate".
* **`des.map()`'s result was discarded** (§12.4).
* **`runProtected` was catching the Longjmp that *is* a Lua error.** §3(d) says
  a `luaL_error` has to unwind through `lua_pcallk` rather than through JS
  frames, and the wrapper's own `try/catch` — there to stash a *JS* throw and
  re-throw it after the stack is unwound — was intercepting it first. Both bugs
  above therefore surfaced as an opaque `Longjmp` object with no message. With
  `if (e instanceof Longjmp) throw e` they surface as
  `lua-port asmodeus.lua: bad argument #2 to '?' (userdata expected, got nil)`,
  which is the difference between ten minutes and an afternoon.

### 12.10 What S5, S6 and S7 still need

Nothing in S4 changed the shape of the remaining three stages, but it did
change what they can assume.

**S5 — `tut-1.lua` (1 file, 4.3 KB).** Still the only string-pattern code in
the corpus (`s:match("^^([A-Z])$")`, two sites) and the only place `nh.eckey`
interpolation matters beyond `tut-2`. The generator would need `a:match(p)` on
a *string* rather than a selection — which is a new kind of method call, since
`method` currently always emits `selection.<name>`. Self-contained, never
reached in normal play, low risk and low value.

**S6 — `nhlib.lua` and `nhcore.lua` (2 files, 12 KB).** S4 has already ported
the single hardest function in `nhlib.lua` and proved the pattern: a library
function generated into `js/lua-js/nhlib-fns.mjs`, taking the api as a
parameter, checked by `checkLibFn`. `extractFunction()` will take the others
the same way — `shuffle`, `d`, `percent`, `monkfoodshop`, `pline` — and
`js/lua-js/nhlib.mjs` already holds hand-written, RNG-exact versions of four of
them to diff against. What is unchanged and still hard is the *load-time*
contract: porting `nhlib.lua` as a whole means the `align` shuffle's two draws
move into JS and the bridge has to own per-state library state, and porting
`nhcore.lua` means reproducing `pairs()` order over a string-keyed table, which
§6.2 showed is a function of `g->seed` and therefore not reproducible — the
dispatch order has to be shown independent of it first. Still only worth doing
if there is time to spare; the interpreter running two small files costs
nothing in the Phase-1 baseline.

**S7 — `themerms.lua` and `hellfill.lua` (2 files, 46 KB).** S4 removed three
of its prerequisites:

* the selection algebra it needs is done and proved (§12.1), including
  `:iterate` and the scalar read-backs;
* `hell_tweaks()` is ported, and `hellfill.lua` is its neighbour in style;
* the fingerprint now covers the whole of `struct obj`, `struct monst` and the
  trap chain, which is what a themed-room port would be judged by.

Four things it still needs, all named in §10 and none touched:

1. **`des.object()`'s return value.** Both files bind it (`local box =
   des.object{…}`, `local o = des.object{…}`) and then call methods on the obj
   userdata. The bridge's `DES_VALUE_FUNCS` is the one-line switch, but doing
   it naively mints a registry reference per `des.object` call and there are
   1,420 of them, so it wants to be conditional on the script rather than
   global.
2. **`obj.*` methods.** `l_obj_register` is already called on the port state,
   but no port has ever used one; `o:placeobj(x, y)` and friends are untested.
3. **Generic `for k, v in pairs/ipairs`.** `themerms.lua:1093` is `ipairs` and
   ordered; `nhcore.lua`'s and `nhlib.lua`'s are `pairs` and are S6's problem,
   not S7's. The generator rejects `in` by name today.
4. **The long-lived state.** `gl.luathemes[dnum]` is cached per dungeon branch
   and never closed — the only level-generation state that outlives its load —
   and `themerms` runs on essentially every ordinary level, so a mistake is a
   corpus-wide failure rather than a one-level one. That also means the corpus
   tests it harder than anything else, which is the argument for attempting it
   at all.

`tools/lua-port-gen/gen-ports.mjs` grows a `T3` list and
`js/lua-js/scripts/t3/`; nothing else about the machinery has to change.

---

## 13. Biggest risk to full coverage

> **S4 update.** The numbers below are now four stages out of date in the right
> direction. The corpus reaches **56** ported level scripts in play, not "perhaps
> a dozen", and 126 of the 131 scripts are ported with synthetic evidence at
> four or five depth/role settings each. The residual risk is unchanged in kind
> and smaller in size: 67 of the 126 have synthetic evidence only (33 from S2,
> 12 from S3, 22 from S4), and a port that is right in the harness and wrong in
> play would still slip through. The cheapest remaining improvement is still the
> same one §7.7 named — one more wizard-mode tour session per role upgrades
> several scripts at once, and after S4 it would upgrade quest branches in three
> tiers rather than one.
>
> **S2 update.** Both halves of this section's "honest answer" now exist and are
> in use: the synthetic harness is `C2JS_LUA_LEVELPROBE` / `--levels=` (§7.6),
> and each stage's write-up carries a per-script evidence table (§7.7). Two of
> the estimates below were pessimistic. The corpus reaches more than "perhaps a
> dozen" — 19 of the 131, because five sessions use wizard-mode level teleport
> to tour the branches — and the synthetic harness cost part of an afternoon
> rather than a leg, because NetHack already contains it as `#wizloaddes`. The
> residual risk is unchanged in kind: 33 of S2's 49 have synthetic evidence
> only, and a port that is right in the harness and wrong in play would still
> slip through.

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

> **S7 update.** That risk was real and it was the one the corpus is best at
> catching: a reversed reservoir loop diverges at RNG index 313 of a marathon
> session, inside the first `makerooms()` (§15.10 control 1). The risk the row
> did *not* name is the one that actually bit — a themed room *fill* is chosen
> once in a thousand rooms, so a wrong one passes the whole 69-session corpus.
> §15.5's themeroom probe is the answer, and it found a bridge bug that had
> been latent since the PoC (§15.4).

---

## 14. Stages S5 and S6: the tutorial, and the two libraries

**Landed.** `tut-1.lua` (S5), `nhlib.lua` and `nhcore.lua` (S6) are ported.
With everything before them that is **129 of 131 files and 92.7 % of the corpus
by bytes**. Two files remain, both S7's: `themerms.lua` (34 KB) and
`hellfill.lua` (11.9 KB).

These three are the first ports that are not *scripts* in the sense the first
four stages meant. `tut-1` is a level script, but it is the only one that calls
a method on something other than a selection. `nhlib.lua` and `nhcore.lua` are
not level scripts at all: their product is a set of names in a `lua_State` that
C, and the two files S7 still owns, call afterwards.

### 14.1 S5 — `tut-1.lua`, and typing the receiver of `a:m(…)`

§12.10 predicted the whole of the port's difficulty and got it right:

> The generator would need `a:match(p)` on a *string* rather than a selection —
> which is a new kind of method call, since `method` currently always emits
> `selection.<name>`.

`a:m(…)` is sugar for `<table>.m(a, …)`, and which table depends on the
receiver's metatable. For 126 ports the answer was always `selection`, because
nhlsel.c registers one method table and points `__index` at it. `tut-1.lua:7`
and `:13` are Lua's *string* metatable instead:

```lua
local s = nh.eckey(command);
local m = s:match("^^([A-Z])$");        -- ^X is Ctrl-X
```

So `isSelectionExpr()` became `exprType()`, which answers `'selection'`,
`'string'`, `'obj'` or null, and `methodJs()` picks the table from it. The two
new tables need a *positively inferred* receiver and are a hard error otherwise;
a selection method keeps the name-based rule the existing ports were generated
under, and errors if the receiver is positively something else. The `--check`
interpreter dispatches on the runtime *value* instead — which is what Lua does —
so a wrong static inference is a check failure rather than a wrong port.

**The port calls the real `str_match`.** A Lua pattern is not a regular
expression: `%` is the escape, `-` is a lazy quantifier, `[` classes differ, and
`^`/`$` anchor only at the pattern's ends. Rather than reimplement any of that,
`bridge.mjs` opens Lua's **string** library — and only that one — in the port's
state with `luaL_requiref(L, "string", luaopen_string, 1)`, and
`string.match(s, p)` runs the same transpiled `str_match` the VM would have
reached through the string metatable. `nhl_init()` opens the same library
(`NHL_SB_STRING` is part of `NHL_SB_SAFE`), so it is the same code on the same
input. §9's gotcha still stands for everything else: opening `math` would
re-seed a PRNG nobody reads, and `luaL_openlibs` would open both.

Three smaller things the script needed:

* **`nh.parse_config`.** `nhl_parse_config()` is exactly
  `parse_conf_str(luaL_checkstring(L, 1), parse_config_line)`, and `tut-1` turns
  on `mention_walls`, `mention_decor` and `lit_corridor` with it before it draws
  anything — options that change what the rest of the game displays, so the
  call has to happen at the same point with the same bytes.
* **`u.role` and `u.uenmax`.** Two more entries of `nhl_meta_u_index()`'s
  {name, &field, type} table, whose offsets the transpiler emitted literally
  (`cptr.add(u, 104)`, `cptr.add(u, 2212)`).
* **nil.** Lua has one absent value and JS has two. `x ~= nil` now emits loose
  `!= null`, which is true for exactly `{null, undefined}`. Strict `!==` was
  right for every existing port (they only ever compare against a `null` the
  emitter itself wrote) and would have been wrong for the first library function
  called with a missing argument: `d(20)`'s `faces == nil` would have been false
  on *both* sides of `--check`, which is the shape of bug that passes every gate.

**The fingerprint had a hole, and tut-1 fell straight into it.** The script is
43 `des.engraving` calls and almost nothing else, and an engraving is not in
`struct rm`, not an object, not a monster and not a trap: it hangs off the
global `head_engr` list. A negative control that changed one engraving's text
**passed the fingerprint** (§14.8, control 4). `levelFingerprint()` now walks
that chain too, with `engr_at()`'s own offsets — position, type, time, size,
`guardobjects`/`nowipeout`, and both `engr_txt[actual_text]` and
`engr_txt[pristine_text]`. `remembered_text`, `eread` and `erevealed` stay out
for the same reason `struct rm`'s `glyph`/`seenv` do: they are what the hero has
read and seen, not what the script built.

**Reachability turned out to be free.** §10 called `tut-1` "never reached in
normal play". It is reached in *ordinary* play by one line of rc:
`ask_do_tutorial()` (options.c:430) skips its menu when `tutorial` was set in
the configuration file, and `maybe_do_tutorial()` (allmain.c:568) then
teleports the hero into `tut-1` as the first thing the game does.
`tools/lua-oracle.mjs --rc=…` drives that, and it is how S6's tutorial half is
evidenced as well.

### 14.2 S6 — what "porting nhlib" means operationally

`nhlib.lua` is not loaded by the level generator. It is loaded by
**`nhl_init()`**, which means *every* `lua_State` the game builds gets it —
one per level load, one per quest message, one for `init_dungeons()`, one for
`gl.luacore`. A chargen-only session builds five; a marathon builds dozens.

So the first question is not how to transcribe the file but what a port of it
would even be. The answer is forced by who calls into it:

| Caller | Reaches |
|---|---|
| C, by name | `nh_get_variables_string` (nhlua.c:1407), `get_variables_string`, `nh_callback_set/rm/run`, the `nhcore` table |
| `nhcore.lua`'s `_G[k]` | `tutorial_cmd_before`, `tutorial_turn` |
| **`themerms.lua` and `hellfill.lua`** | `percent` ×41, `math.random` ×28, `shuffle` ×13, `align` ×18, `d` ×5, `pline` ×4, `hell_tweaks` ×2 |

That last row is the constraint. Those two files are S7's and are still
interpreted, and they call nhlib's globals ninety times over. **A port of
nhlib.lua therefore has to leave callable Lua values in the state**, not JS
ones — there is no version of this that is only a JS module.

In this transpile that is nearly free, for the reason §2 already recorded: a C
function pointer *is* a JS function object, so `lua_pushcclosure(L, jsFn, 0)`
makes a JS function a valid `lua_CFunction`. `bridge.mjs` grew two calling
conventions over that — `luaFn` (arguments converted to JS, return value
pushed) and `luaRawFn` (the stack itself, for the three functions that rewrite
or walk a caller's table) — and `js/lua-js/scripts/nhlib.mjs` installs fifteen
of them.

**The state cursor.** A library function is called *by Lua*, with Lua values
that belong to the calling state: `hellfill.lua`'s `hell_tweaks(protected)`
hands over a selection userdata that cannot be moved to another state. So the
bridge's api gained an active-state cursor: while a library port runs,
`state()` answers with the state that called it and every `des.*` /
`selection.*` / `obj.*` the ported body issues is marshalled there. A level
script's port is unaffected — the cursor is null and it gets the port-owned
state exactly as before.

**The load-time RNG contract, which is the whole risk of this stage.**
`nhlib.lua:24` is

```lua
align = { "law", "neutral", "chaos" };
shuffle(align);
```

and that spends exactly two draws — `rn2(3)` then `rn2(2)`, from
`math.random(i)` for i = 3 and i = 2 — inside **every** `nhl_init()`. Four
stages have been built on that fact: §2 says the bridge's own state must not be
created with `nhl_init()` because it would duplicate them, and §7.3 says a port
that wants `align[1]` must read it out of the interpreter's state rather than
recompute it. Both still hold, unchanged. What the port has to do is spend the
same two draws in the same order at the same seam, and it does: the seam is the
`fclose` of `nhlib.lua`, which is *inside* `nhl_init()`, after the state is
fully registered and before anything else has happened, and the shuffle is the
same `shuffleWith()` every other port draws through. The oracle prints it
directly — `rng draws inside port: [2,0,2,0,2,2,0,2,162]` on the tutorial
session, one `2` per `nhlib.lua` load and a `0` for `nhcore.lua`, which draws
nothing.

`align` itself is still read back out of the interpreter's state by
`interpAlign()`, and has to be: the port writes it *there*, so the two scripts
that name `align[1]` see the same table `themerms.lua` and `hellfill.lua` see.

**nhcore.lua** is the smaller half and the same shape. It is loaded once, into
`gl.luacore`, by a state that `nhlib.mjs` has already furnished. Its port
defines `nh_lua_variables`, four functions C calls by name, `show_getpos_tip`,
and the `nhcore` hook table — with exactly three entries, because
`l_nhcore_call()` uses the *absence* of the other four names to switch those
hooks off after one attempt, and a port that helpfully defined them would change
behaviour.

One global is defined and unreachable. `mk_dgl_extrainfo()` writes a
dgamelaunch status file with `io.open`, which the sandbox does not open at all;
`nhcore.moveloop_turn` is commented out in the .lua, and `nh_callback_run`'s
`_G[k]` can only name something that was passed to `nh.callback()` — which in
the whole 131-file corpus is `tutorial_cmd_before` and `tutorial_turn`, from
nhlib's two tutorial functions and nowhere else. The port defines it, because
the global's *type* is observable and has to match, and makes it throw, because
that turns the reachability argument into an assertion. It has never fired.

### 14.3 Proving a library function

A level script's port is proved by its call stream; that is all a level script
is. Most of nhlib.lua is not: `percent`, `d`, `monkfoodshop`,
`table_stringify` and `tutorial_cmd_before` make no calls at all and their
whole observable is a *return value*, and `shuffle` returns nothing and rewrites
its argument in place.

So `checkLibFn` now compares four things, over a list of argument vectors, under
all eight RNG settings: the call stream, the return value, the number of `rn2`
draws spent, and any mutation of an argument. `gen-ports.mjs`'s `LIB_ARGV`
carries the vectors — five thresholds for `percent`, six dice shapes for `d`,
four list lengths for `shuffle`, four tables for `table_stringify` — and
`node --test` runs all of it in about 300 ms.

**Eight functions are generated**, by the same `lua2des.mjs` that emits the
level scripts, now into a module with named exports rather than one function per
file: `hell_tweaks`, `monkfoodshop`, `nh_set_variables_string`,
`nh_get_variables_string`, `tutorial_cmd_before`, `tutorial_enter`,
`tutorial_leave` (into `js/lua-js/nhlib-fns.mjs`) and `show_getpos_tip` (into
`js/lua-js/nhcore-fns.mjs`). `extractFunction()` grew two things for them: a
file-scope `local` the function closes over comes along and becomes a
module-level `const` (`tutorial_blacklist_commands`, `tutorial_events`), and a
definition written as an assignment rather than a declaration
(`math.random = function(...)`) is recognised.

**Eleven are hand-written**, in `js/lua-js/nhlib.mjs` and
`js/lua-js/nhcore.mjs`, because they use constructs a generator should not
attempt: varargs, a generic `for k, v in pairs(…)`, simultaneous assignment
through an index, `_G[k]`, and Lua's own `type`/`tostring`/`table.unpack`. They
are proved the same way, and that required the *interpreter* half of
`lua2des.mjs` to learn those constructs while the *emitter* half keeps refusing
every one of them by name (`EMITTER_REFUSES`). The generated-port contract is
therefore unchanged: nothing a generated module can contain has grown.

The two on that list that matter most are `shuffle` and `math.random`. Every
`percent()`, every `d()`, every shuffled list in 127 ports draws through them —
and until S6 **nothing had ever compared them with `nhlib.lua`**, because
`--check` handed *both* sides the same `makeNhlib()` and so compared two
transcriptions of a function it was itself supplying. Now the .lua side runs
nhlib.lua's own statements, the JS side runs `shuffleWith` /
`mathRandomWith`, and what is shared is only the `rn2` underneath. That is a
retroactive proof of four earlier stages' RNG accounting, and it is the single
most valuable thing S6 produced.

### 14.4 `pairs()`, measured

§10 named this as S6's hard problem:

> porting `nhcore` requires reproducing `pairs()` order over a string-keyed
> table, which §6.2 showed is a function of `g->seed` and therefore not
> reproducible — the dispatch order has to be shown independent of it first.

There are three hash-part tables in the two files: `nhcore` itself,
`nh_lua_variables`, and each `nh_lua_variables._CB_<event>`. The answer has
three parts and none of them is "reproduce the order".

**1. The port does not choose an order.** `table_stringify` and
`nh_callback_run` walk *the caller's own Lua table*, and the port walks it with
`lua_next` — the same traversal the interpreter's `pairs` performs, of the same
table, in the same state. The order is identical by construction rather than by
agreement, which is why `bridge.mjs`'s `luaTable.pairs` exists at all.

**2. Where an order is nevertheless visible, it is seed-derived, and that is
measured.** §6.2 settled the same question for `questtext` by loading it eight
times in one run and watching the *interpreter alone* produce eight different
orders. `gl.luacore` is built once per game, so `tools/lua-pairs-probe.mjs`
does the equivalent across eight runs: `luai_makeseed()` mixes `time(NULL)`,
which the harness pins from the session's `datetime`, so varying the datetime
varies `g->seed` exactly as a different allocation history would. Interpreter
only, no port anywhere:

```
  nhcore.lua:nhcore: 4 distinct orders in 8 runs
    x3  a30bc1b5  getpos_tip,enter_tutorial,leave_tutorial
    x2   e351d89  getpos_tip,leave_tutorial,enter_tutorial
    x2  9de01a79  enter_tutorial,getpos_tip,leave_tutorial
    x1  b4b31381  enter_tutorial,leave_tutorial,getpos_tip
```

The same probe over `align` reports **one** key order in all eight runs —
`1,2,3` — because it is an array part, and an array part's order is not
seed-derived. That contrast is what makes the measurement worth having: had
`align` moved, the port would be wrong. The oracle therefore requires the
lua_next order of `align` to match and only *reports* `nhcore`'s, exactly as
§6.2 requires `dungeon`'s and reports `questtext`'s. Nothing walks `nhcore`
with `lua_next` anyway — `l_nhcore_call()` reads it with `lua_getfield`.

**3. For the one table a `pairs()` order could actually reach the game
through, the order is unique.** `nh_callback_run` iterates
`nh_lua_variables["_CB_" .. cb]`, whose keys are the function names passed to
`nh.callback()`. `nh.callback(` appears **four times in the whole corpus**, all
of them in nhlib.lua's `tutorial_enter` and `tutorial_leave`, and they register
one function per event (`tutorial_cmd_before` for `cmd_before`,
`tutorial_turn` for `end_turn`). Every reachable `_CB_*` table therefore has at
most one key, and a one-key table has one traversal order. The four C call sites
are gated on `nhcb_counts[]`, so in a game that never enters the tutorial
`nh_callback_run` is never called at all and `nh_lua_variables` stays empty —
which is also why `table_stringify`'s `pairs` produces `"{}"` in every corpus
session.

### 14.5 The assertion: what still reaches the Lua parser

The stated goal of roadmap 1.10 is that a game with every port live never parses
a line of Lua. That is not something the corpus or the RNG log can show — a port
that quietly stopped running and let the interpreter do the work would pass
both — so S6 measures it directly, at the one place every `.lua` enters the VM.

`registry.mjs`'s `scriptFor()` is called from the harness's `fopen` for every
file the game opens. A name the registry does not handle goes to the interpreter
with its real bytes, and is now counted; the count travels out through
`runBootGame`'s result and the oracle prints it. On every session tried, with
all 129 ports live, the answer is:

```
      .lua still parsed:   themerms.lua×1
```

and, when a Gehennom filler level is forced,
`hellfill.lua×1, themerms.lua×1`. Those two files are S7's and nothing else
remains: **129 of the 131 scripts, and every one of the ~60 `.lua` loads a
marathon session performs, are intercepted.** `themerms.lua` is loaded once per
dungeon branch that names it (only the main dungeon does — `dungeon.lua:13`) and
cached in `gl.luathemes[dnum]`; `hellfill.lua` is `svd.dungeons[].fill_lvl` for
Gehennom and is loaded per filler level.

Two honest qualifications. The interpreter still *compiles* something for each
ported file — the same-length `--[[ ]]` stub §4 describes, which is an empty
chunk — so "never parses any .lua source" is exact and "never runs the Lua
parser" is not. And the interpreter itself is still in the tree and still
running, because it is the differential oracle; removing it was never the goal.

### 14.6 Evidence, per script

| Script | .lua lines | What it adds | Evidence |
|---|---|---|---|
| `tut-1` | 347 | `s:match(p)`, `nh.parse_config`, `u.role`/`u.uenmax`, 43 engravings, `shuffle` + `for` + `percent` | **both** — forced generation at Dlvl 1, Dlvl 10, a Monk game and a Knight game; and *ordinary play* via `OPTIONS=tutorial` as Knight, Monk and Wizard |
| `nhlib` | 242 | fifteen globals, two load-time draws, the Lua-callable surface themerms/hellfill use | **every session** — it is loaded by every `nhl_init()`, so all 69 corpus sessions exercise it dozens of times |
| `nhcore` | 144 | the hook table, the callback registry, `_G[k]` dispatch | **every session** for the load and the four self-disabling hooks; the tutorial rc session for `enter_tutorial`/`leave_tutorial` and for `nh_callback_run` firing every turn |

The `getpos_tip` hook is the one part of `nhcore` no session reaches: it needs
the hero to enter `getpos()` for the first time, which none of the 69 recorded
sessions does. It is a two-line generated function (`nh.text` of a fixed
string), it is checked against the .lua by `checkLibFn`, and its presence and
type in the hook table are checked by the globals dump — but it has no
behavioural evidence, and that is worth writing down rather than glossing.

### 14.7 Oracle results

The library ports need a sixth check, for the same reason the read-back scripts
needed a fifth: their product is a set of globals, and neither the RNG log, the
screens nor the level fingerprint sees one. `--globals` adds two runs with
`C2JS_LUA_GLOBALS=dump`, which records — per load, per expected global — the Lua
type actually found and, for the tables, the content hash and the raw `lua_next`
order. As with `--readback`, the interpreter side runs the real chunk from this
module at the same `fclose` seam, so both dumps are taken at the same instant of
the same game, and the RNG logs of the dump runs are checked against the plain
ones to show the instrumentation changed nothing.

```
$ node tools/lua-oracle.mjs --globals sessions/seed0077-rogue-chargen.session.json
PASS  seed0077-rogue-chargen.session.json
      rng     interpreter=3242 port=3242 firstDiff=-1
      screens interpreter=33 port=33 firstDiff=-1
      ported-script loads: nhlib.lua@rng200, dungeon.lua@rng202, nhlib.lua@rng302,
                           nhcore.lua@rng304, nhlib.lua@rng306, nhlib.lua@rng3191,
                           quest.lua@rng3193
      rng draws inside port: [2,0,2,0,2,2,0]
      library globals:     MATCH (5 loads of nhlib.lua+nhcore.lua; every global the
                           expected type: yes; lua_next order MATCH; instrumentation
                           undisturbed)
        nhlib.lua[math.random:function shuffle:function align:table:1690268d:3
                  d:function percent:function monkfoodshop:function hell_tweaks:function
                  pline:function nh_set_variables_string:function
                  nh_get_variables_string:function table_stringify:function
                  tutorial_cmd_before:function tutorial_enter:function
                  tutorial_leave:function tutorial_turn:function]
      .lua still parsed:   themerms.lua×1
```

The tutorial session — the one that exercises `tut-1`, `tutorial_enter`,
`nh_callback_set`, `nh_callback_run` once per turn and `tutorial_leave` — is
`PASS` on all of it for Knight, Monk, Wizard and Valkyrie.

`hellfill.lua` is the sharpest test of the nhlib port, because it is *still
interpreted* and reads `align` eighteen times, draws through `math.random`
twenty-eight times and ends with two `hell_tweaks()` calls — every one of which
now goes through a JS `lua_CFunction`. Forced on the wizard world tour it builds
byte-identically:

```
$ node tools/lua-oracle.mjs --levels=hellfill.lua sessions/seed0360-wizard-world-tour.session.json
PASS  seed0360-wizard-world-tour.session.json
        ok   hellfill.lua   fp a67192d4/a67192d4 rng 5117/5117 (still interpreted)
      .lua still parsed:   hellfill.lua×1, themerms.lua×1
```

**The 128 earlier ports are unaffected**, and it is worth saying why that was
not obvious: S6 changes what `percent`, `shuffle`, `math.random`, `d` and
`align` *are* for every script in the game, ported or not. All 128 still MATCH
forced at Dlvl 1 (eight batches of ≤16 per process; §11's budget note still
applies), the plain oracle on `gen9996-marathon-dlvl10` still reports
`rng 54924/54924, screens 17829/17829`, `seed0360-wizard-world-tour` still
reports `120639/120639`, and `--readback --questprobe --globals` on
`seed0077-rogue-chargen` reports `read-back table: MATCH` with the `lua_next`
order over `dungeon` matching, the quest text byte-identical
(`23882 terminal bytes, firstDiff=-1`) and `library globals: MATCH`.

### 14.8 Negative controls

Four, of which two are the ones the brief asked for and one found the hole in
the fingerprint. Every one was reverted.

1. **nhlib's `shuffle` draw accounting.** `shuffleWith`'s loop bound
   `i >= 2` → `i >= 1`, i.e. one extra `math.random(1)` per shuffle — a draw
   that always returns 1 and changes nothing about the result. **Three
   detectors fire.** `checkLibFn` reports it as
   `shuffle rng=low argv=1 rn2 draws: lua=0 js=1` (the argv-1 vector is a
   one-element list, where the .lua spends nothing and the control spends one).
   The RNG log diverges at index 202 — `nhlib.lua`'s very first load, and the
   whole log shortens from 3242 draws to 3115. And the globals dump reports
   `align` with a different content hash. This is the control the brief named:
   the draw accounting is checked mechanically, behaviourally, and in the
   product.
2. **A nhcore global, invisible to everything else.** `mk_dgl_extrainfo` not
   defined. `rng 3242/3242 firstDiff=-1`, `screens 33/33 firstDiff=-1`, level
   fingerprint `MATCH` — **caught only by the globals dump**, which reports
   `mk_dgl_extrainfo:nil` against the interpreter's `:function`. This is §5's
   statue control in its S6 form, and it is why the dump records the Lua type of
   every expected name rather than only hashing the tables.
3. **A nhcore callback, in the tutorial.** The hook table's
   `enter_tutorial = tutorial_enter` → `tutorial_leave` — a transcription slip
   that is one identifier wide. On the `OPTIONS=tutorial` session the RNG log
   diverges at 2842 (the moment `maybe_do_tutorial()` runs), the screens at 15,
   the level fingerprint has one entry fewer because `tut-1` is never generated
   at all, and the globals dump differs. Everything fires, which is the point:
   the tutorial path is not a corner the oracle cannot see into.
4. **An engraving's text — the one that failed.** `tut-1`'s
   `"Move around with " .. movekeys` → `"Move around With "`. Against the §12.5
   fingerprint this **passed**: `fp ef977367/ef977367 MATCH`, and only the
   screens noticed, and only because the level probe leaves the hero standing on
   the forced level. An engraving is a fifth chain — `head_engr` — that nothing
   swept. With §14.1's widening the same control moves the fingerprint
   `d705d960` → `34b99ce0` on its own. This is §11.5's control 4 and §12.8's
   control 5 happening a third time, and it is the argument for taking a
   negative control that *passes* as the most useful result available.

**And two bugs the corpus found that nothing else could.** Both are worth
recording because they are the shape of thing a library port produces, and
because they are the argument for running the whole corpus rather than the
oracle on a few sessions.

* **`tutorial_turn` walked a JS list through Lua's `pairs`.** The api a library
  port is handed answers `pairs` with `lua_next`, which is right for every
  table that lives in the game — and wrong for `tutorial_events`, which is a
  file-scope local that never leaves JS. Marshalling it into Lua and walking it
  there produced a registry handle where the ported body expected an object, so
  `v.func` was not a function. Five corpus sessions failed, and all five were
  ones with no `!tutorial` in their rc whose recorded keys happen to answer the
  tutorial menu with *yes* — i.e. exactly the sessions that reach the code. The
  fix is that `luaTable.pairs` and `setNil` dispatch on where the value lives,
  and the JS side of that dispatch is now the *same function*
  (`js/lua-js/nhlib.mjs`'s `jsPairs`) that the `--check` interpreter uses, so
  the two cannot drift.
* **`luaL_ref` on the wrong state.** `luaFn` converted its arguments to JS
  *before* binding the api to the calling state, so a table or userdata
  argument was pushed on the caller's stack and referenced into the port's
  registry. One corpus session hands a library function a table
  (`seed4500-knight-coverage`), and it aborted inside `luaF_close`. Conversion
  now happens inside `withState` with everything else. This is §7.4's bug in a
  new place — the port's state shadowing the interpreter's — and the lesson is
  the same one: state identity has to be explicit, never inferred.

### 14.9 What S7 still needs

> **Answered in §15.** All four outstanding items landed. Two of the
> predictions were wrong in detail: `des.object()`'s return value did want a
> per-script switch but `LuaRef` was the wrong shape for it (a registry
> reference with an explicit lifetime is), and `themerms.lua`'s long-lived
> state turned out to be observable only through the *load count* — a control
> that rebuilt the port's world per level passed every check. Two things the
> section did not predict: the state is memory-capped at 1 MB and therefore
> needs those lifetimes at all, and reading a Lua boolean out of the
> marshalling buffer had been wrong since the PoC (§15.4).

`themerms.lua` (34 KB, 87 functions) and `hellfill.lua` (11.9 KB) are the last
two files, 7.3 % of the corpus by bytes. S5 and S6 removed three more of the
prerequisites §12.10 listed and added one fact that changes the shape of the
stage.

Removed:

* **`obj.*` methods.** §12.10 called them "untested". `obj.new` and
  `obj.placeobj` are now bound, typed by the emitter (`exprType` answers
  `'obj'`), driven by nhlib's `tutorial_events` closure, and checked by
  `checkLibFn`.
* **Generic `for k, v in pairs/ipairs`.** The parser and the `--check`
  interpreter have it (§14.3); `themerms.lua:1093` is an `ipairs` and ordered.
  What is *not* done is emitting one — `EMITTER_REFUSES` still rejects it, on
  purpose, so S7 must either extend the emitter deliberately or hand-write the
  function and prove it with `checkLibFn`, which is now a real option.
* **The whole library surface.** `percent`, `shuffle`, `math.random`, `d`,
  `align`, `pline` and `hell_tweaks` are ports, and `themerms.lua` already runs
  against them today — the only thing S7 changes is who *calls* them.

Still outstanding, and unchanged:

1. **`des.object()`'s return value.** Both files bind it and call `obj` methods
   on the result. `DES_VALUE_FUNCS` is the one-line switch and `obj.*` now
   works, but turning it on globally mints a registry reference per
   `des.object` call and there are 1,420 of them, so it wants to be conditional
   on the script. The `LuaRef` path S6 added for `nh_lua_variables` is the
   cheaper shape if a reference per object turns out to matter.
2. **The long-lived state.** `gl.luathemes[dnum]` is cached per dungeon branch
   and never closed — the only level-generation state that outlives its load.
   Every port so far has run inside one `nhl_loadlua` and been done;
   `themerms.lua` leaves a table of 87 room generators behind and `makerooms()`
   calls into it on every ordinary level. The nearest thing S6 built is the
   library port, which also leaves callable values behind in a state it does not
   own — `js/lua-js/scripts/nhlib.mjs` is the template.
3. **Reservoir sampling.** `themerms` picks a room by frequency-weighted
   sampling; a single misordered `nh.rn2` shifts every subsequent room in the
   dungeon. It runs on essentially every level, so a mistake is a corpus-wide
   failure rather than a one-level one — which is also why the corpus tests it
   harder than anything else, and why §13's advice to attempt it only with the
   whole corpus green and a leg budgeted for backing it out still stands.

New, and worth planning for:

4. **`themerms.lua` is one of the two files whose `pairs()` §3(a) flagged, and
   it is the *only* remaining one.** §14.4 disposed of nhcore's and nhlib's by
   measurement and by cardinality. `themerms.lua:1093` is an `ipairs` over a
   sequence and is ordered, so the same treatment applies — but it should be
   measured with `tools/lua-pairs-probe.mjs` rather than assumed, because that
   tool now exists and the argument for `nhcore` took ten minutes to make with
   it and would have taken an afternoon without.
5. **`tools/lua-port-gen/gen-ports.mjs` grows a `T4` list** (S5 took `T3` for
   `tut-1`) and `js/lua-js/scripts/t4/`; `LIB_MODULES` and `HAND_FNS` take
   `themerms`' 87 functions the way they took nhlib's fifteen. Nothing else
   about the machinery has to change.

---

## 15. Stage S7: themed rooms, and the Gehennom filler

**Landed.** `themerms.lua` (34 KB, 1,097 lines) and `hellfill.lua` (11.9 KB,
443 lines) are ported. That is **131 of 131 files and 100 % of the corpus by
bytes**, and a game with every port live parses **zero bytes of Lua source**
(§15.9).

The two files are as different from each other as any two in the corpus.
`hellfill.lua` is a level script — the biggest one, but still a call stream —
and the generator took it with one new construct. `themerms.lua` is the only
script in the corpus whose lua_State outlives the level that created it, and it
needed a shape of its own.

### 15.1 `hellfill.lua`: the last generated level script

`svd.dungeons[].fill_lvl` for Gehennom, i.e. every level of Gehennom that is
not `valley`, `asmodeus`, `orcus`, `juiblex`, `baalz`, `wizard1/2/3`,
`fakewiz1/2` or `sanctum`. Its body is `local hellno = math.random(1, #hells);
hells[hellno]()` over seven whole level generators, followed by a staircase, a
`u.invocation_level` branch and `populatemaze()`.

`tools/lua-port-gen/lua2des.mjs` emitted it with **one** addition: Lua's own
`type()`. `rnd_hell_prefab()` picks from a list that mixes bare functions with
`{repeatable = true, contents = function() … end}` tables and tells them apart
with `type(fab)`, so `type` joined the api — answered by `jsType()`, the same
function the `--check` interpreter uses, so the two cannot disagree. Two
smaller things came with it: `u.invocation_level`, which is
`Invocation_lev(&u.uz)` pushed as a *boolean* (nhlua.js:2058), and three more
`--check` RNG settings.

**Why three more settings.** `hellfill.lua` chooses one of seven level
generators with its *very first draw*, so which arms `--check` visits is
decided before anything else happens: `low` selects generator 1, `high` selects
7, and settings 1–6 between them select only 3 and 4. Settings 8, 14 and 47 are
chosen so that 2, 5 and 6 — the mazegrid one that calls `hell_tweaks()`, the
thick-walled one and the cold one — are transcription-checked too. Without them
three of the seven generators would have been emitted and never compared.

**Three of its seven functions are unreachable, and a negative control proved
it.** `hellobjects()`, `hellmonsters()` and `helltraps()` are defined and never
called — the file's only callers are `hells[n]()` and `populatemaze()`. A
control that made `hellmonsters()`'s last monster peaceful **passed** both
`--check` and the oracle, which is how that was established rather than
assumed; the same control inside `populatemaze()` fires on both (§15.8).

### 15.2 `themerms.lua`: the only state that outlives its load

Every other script in the corpus runs inside one `nhl_loadlua()` and is done.
`themerms.lua` does not:

```c
makerooms()                                   /* mklev.c:366 */
  themes = gl.luathemes[u.uz.dnum];                  /* may already exist */
  if (!themes) { themes = nhl_init(&sbi);            /* 1 MB sandbox */
                 nhl_loadlua(themes, "themerms.lua");
                 gl.luathemes[u.uz.dnum] = themes; } /* and KEPT */
  lua_getglobal(themes, "pre_themerooms_generate");   nhl_pcall_handle
  while (…) lua_getglobal(themes, "themerooms_generate");  nhl_pcall_handle
  lua_getglobal(themes, "post_themerooms_generate");  nhl_pcall_handle
themerooms_post_level_generate()              /* mklev.c:1174 */
  lua_getglobal(themes, "post_level_generate");  nhl_pcall_handle
  lua_gc(themes, LUA_GCCOLLECT);
```

The chunk runs **once per dungeon branch** — only the Dungeons of Doom names a
themerms file (`dungeon.lua:13`), so once per game — and C calls back into what
it left behind on every ordinary level of that branch, until
`free_luathemes()` releases it (mklev.c:345, from `do.c:1646` on entering the
endgame or leaving the tutorial and from `save.c:1067` at the end of the game).

So the port is a *library* port in exactly the sense §14.2 established for
`nhlib.lua`: `js/lua-js/scripts/themerms.mjs` runs at the `fclose` seam against
the state `nhl_loadlua()` was handed, and leaves fifteen callable Lua values
behind. The bodies live in `js/lua-js/themerms-fns.mjs`, which imports nothing,
so `--check` can run them without the transpiled game in scope — the same split
`nhlib-fns.mjs` has from `scripts/nhlib.mjs`.

Everything is built *inside* the port function rather than at module scope: one
load means one set of closures over one `postprocess` queue, which is what one
chunk load's upvalues are.

**`align` comes out of that state, not out of `interpState()`.** §7.3's
`interpAlign()` takes the *most recently created* lua_State, which is right for
a script being loaded and wrong here: by the time a themed room is generated the
newest state is some other level's. `alignIn(L)` reads it from the state the
port was handed, once, at load — it is shuffled at that state's `nhl_init()` and
never changes afterwards.

### 15.3 Three things the bridge did not have

**1. `des.object()`'s return value, per script.** `lspo_object()` always pushes
the obj it made and 1,420 calls in the corpus ignore it; two in `themerms.lua`
do not (`local o = des.object{…}` in Buried zombies, `box = des.object{…}` in
the Water-surrounded vault). Taking the result costs a `luaL_ref` each, so
`DES_VALUE_FUNCS` stays `{map}` and `withDesObjectResult()` turns `object` on
around this script's entry points alone. §12.10 predicted this and predicted it
correctly.

**2. Lifetimes — the part §12.10 did not predict.** Until S7 nothing ever
released a registry reference, and that was harmless for 129 ports because the
state holding them dies with the script. `gl.luathemes[dnum]` does not, and it
is created by `nhl_init()` with a **1 MB memory cap** (mklev.c:369). A
`selection.room()` userdata is over a kilobyte and `themerms.lua` takes one or
two per themed room, so leaking them would exhaust the sandbox inside one game.
The interpreter does not leak them — they are Lua locals, collected by the
`lua_gc(themes, LUA_GCCOLLECT)` above — so the port reproduces the .lua's two
lifetimes explicitly:

* `withCallValues()` releases everything a room generator took when the C entry
  point returns, which is before `makerooms()`'s next call and long before the
  collection;
* `keepValue()` marks the one value that escapes into `postprocess` — the
  Garden fill's `selection.room()`, read by `make_garden_walls()` after the
  level is finished — and `releaseKeptValues()` drops it where
  `post_level_generate()` drops the .lua's last reference.

This is not only about memory. An obj userdata carries `obj->lua_ref_cnt`, which
`l_obj_gc()` decrements; a reference the port never released would leave that
count high on an object the interpreter had already let go.

**3. The tables a callback is handed.** `readIntTable()` had been reading
`x`/`y`/`w`/`h`/`lit`/`rlit`/… as integers since the PoC, and **none of those
are the field names `l_push_mkroom_table()` actually pushes**: they are `width`,
`height`, `region = {x1,y1,x2,y2}`, the three booleans `lit`/`irregular`/
`needjoining` and the string `type` (nhlua.c:3059). No port had ever read one —
the nine `contents = function(rm)` closures in the T2 tier ignore their
argument — so it had never mattered. `themerms.lua` reads `rm.lit`, `rm.width`,
`rm.height` and `rm.region.x1`, so `readRoomTable()` now reads exactly what the
C function pushes, by name and by type.

`wrapCallback()` also grew a third shape: `lspo_object()` invokes a container's
`contents` with the **obj userdata** (`nhl_push_obj`), which is what the Buried
treasure fill reads with `otmp:totable()`. It dispatches on what is on the stack
— two numbers for `l_selection_iterate`, a table for room/region/map, userdata
for object — rather than on the JS function's arity.

### 15.4 The bug the themeroom probe found

> `lua_toboolean()` returns an `int` in C. This transpile emits its body as
> `return !(…)` (`js/generated/lapi.js:410`), i.e. a JS **boolean**. Four sites
> in `bridge.mjs` wrote `lua_toboolean(…) !== 0`, and `false !== 0` is `true`.

Every Lua boolean the port read came back `true`. The consequence was invisible
for 129 ports — no earlier port reads a boolean out of Lua at all — and immediate
for this one: `rm.lit` was always `true`, so the Garden themeroom fill was
eligible in unlit rooms. The interpreter printed
`Warning: fill 'Garden' is not eligible in room that generated it` twice in a
ten-level game and the port printed it never.

It was found by the themeroom probe (§15.5), not by the corpus: a themeroom
fill is chosen once in a thousand rooms, so a whole 69-session corpus run passed
with the bug in place. Every read of a Lua boolean now goes through one
`luaBool()` helper.

The same mistake was latent in `callGlobal()`, which is how nhcore.lua's
`nh_callback_run` dispatches: it returned `true` for a callback that returned
`nil`. That one is genuinely unobservable — all four C call sites ask
`nhl_pcall_handle` for **0** results (allmain.c:559, cmd.c:468, do.c:1587,
mklev.c:1423) — but it is fixed by the same helper.

### 15.5 The themeroom probe

§7.6's level probe forces a *level* script; there is no such thing for a
themeroom, because `themerms.lua` is not loaded by `load_special()`. NetHack
supplies the hook itself: `nhl_get_debug_themerm_name()` (nhlua.c:1147) reads
`THEMERM` and `THEMERMFILL` from the environment in wizard mode, and
`themerooms_generate()` then generates that room half the time, on every level.

`js/boot/harness.mjs` gained one line — `...(opts.env || {})` on its `ENV`
object, inert unless a caller passes something — and `tools/lua-oracle.mjs`
gained `--themerm=` / `--themermfill=`, which set it on **both** sides of the
comparison. The probe is not a bespoke code path: it is the game's own developer
hook, driven from JS instead of from a shell.

That turns "45 of the 46 themeroom closures are rolled once in a thousand rooms"
into behavioural evidence for every one of them. All 31 themerooms and all 15
themeroom fills PASS the five-check oracle on a nine-level wizard game
(§15.7).

### 15.6 Proving a chunk: `checkChunk()`

`checkPort()` suits a level script, whose whole body is a call stream.
`checkLibFn()` suits one function lifted out of a library file.
`themerms.lua` is neither: its top level defines two tables of 46 closures and
ten functions, spends no RNG and issues no call, and everything interesting
happens when `makerooms()` calls back into it later.

So `checkChunk()` runs the chunk's top level on both sides — the .lua's
statements in this file's interpreter, the port's `makeThemerms(api)` — and then
drives **the protocol C drives**:

```
pre_themerooms_generate()
themerooms_generate() x12          -- mklev.c's "make rooms until satisfied"
post_themerooms_generate()
themerooms[k].contents()      for k = 1..31    -- the sweep, see below
themeroom_fills[k].contents(rm) for k = 1..15
post_level_generate()                          -- the deferred handlers
```

with one shared RNG per side. After each step it compares the call stream, the
number of `rn2()` draws spent and the step's own result; at the end it compares
`name`, `frequency`, `mindiff` and `maxdiff` for all 46 entries.

The sweep is the half that makes it worth having. The `default` themeroom has
frequency 1000 against 45 for everything else, so the sampled protocol on its
own visits the other thirty closures roughly never — 223 recorded calls across
the eleven RNG settings. With the sweep it is **8,899**, and every closure,
every `eligible` predicate and every difficulty gate is compared. `is_eligible`
is called the way `themeroom_fill()` calls it, so the `eligible` closures are
checked by their return value as well as by what they do.

Three constructs the *parser* and the *interpreter* had to learn for this (the
emitter still refuses all of them, so nothing a generated module can contain has
grown): multiple assignment to bare names (`ltype, rtype = rtype, ltype`), a
bare `return` immediately before `elseif`, and `table.insert`. Plus `math.abs`,
`math.floor`, `%i` in `string.format`, `nh.impossible`,
`nh.level_difficulty`, `nh.debug_themerm`, `nh.start_timer_at`, and stub
read-backs for `obj:totable()` and `obj:class()` so that both arms of the
Water-surrounded vault's `if itmcls["material"] == "glass"` are visited.

### 15.7 `ipairs`, measured

§14.9 asked for this to be measured rather than assumed, and
`tools/lua-pairs-probe.mjs` exists to do it. `themerms.lua:1093` is

```lua
for i, v in ipairs(postprocess) do  v.handler(v.data);  end
```

`postprocess` is a file-scope local, appended to only with `table.insert` and
reset only with `postprocess = { }`, so it is a pure sequence — and `ipairs`
visits `1, 2, 3, …` by the language's definition, not by the table's layout.
What could still have been seed-derived is the *array part's* traversal order,
and the probe measures exactly that on the two sequences in the same state that
the globals dump can see. Eight runs, eight different `luai_makeseed()` values,
interpreter and port alike:

```
  themerms.lua:themerooms:      1,2,3,…,31   in 8 of 8 runs (one key order)
  themerms.lua:themeroom_fills: 1,2,3,…,15   in 8 of 8 runs (one key order)
  nhcore.lua:nhcore:            4 distinct orders in 8 runs
```

The contrast is the point: `nhcore`'s three string keys land in four different
orders across eight seeds, and the two sequences land in one. An array part's
order is not a property of `g->seed`; a hash part's is. (The per-entry *values*
of `themerooms` are hash-part tables, so the recursive order hash does vary —
seven distinct in eight runs — which is why the oracle requires the **content**
hash to match and only reports the order, exactly as §6.2 does for `questtext`.)

### 15.8 Oracle results

`themerms.lua` runs on every ordinary level of the main dungeon, so the plain
five-check oracle is the whole test. Seven settings, no probe:

| Session | rng | screens | fingerprint |
|---|---|---|---|
| `seed0077-rogue-chargen` (Dlvl 1) | 3242 = | 33 = | MATCH |
| `gen9996-marathon-dlvl10` (10 levels) | 54924 = | 17829 = | MATCH |
| `gen9005-monk-human-items` | 3816 = | 136 = | MATCH |
| `gen9011-valkyrie-dwarf-items` | 3080 = | 136 = | MATCH |
| `seed0014-dequa-fountain-explore` | 59178 = | 714 = | MATCH |
| `seed0030-ten-diverse-deaths` | 108079 = | 1953 = | MATCH |
| `seed4500-knight-coverage` | 108275 = | 1814 = | MATCH |

`hellfill.lua` is forced with `--levels=hellfill.lua`, at five settings:

```
seed0077-rogue-chargen      hellfill.lua  fp 481ff12d/481ff12d  rng 2767/2767
gen9996-marathon-dlvl10     hellfill.lua  fp 332bbeb8/332bbeb8  rng 4977/4977
gen9005-monk-human-items    hellfill.lua  fp 852e08fc/852e08fc  rng 1666/1666
gen9011-valkyrie-dwarf-items hellfill.lua fp eb6daf97/eb6daf97  rng 1413/1413
seed4500-knight-coverage    hellfill.lua  fp cf7825a5/cf7825a5  rng 3543/3543
```

and on `seed0360-wizard-world-tour` it reproduces **S6's own recording of the
interpreted script** — `fp a67192d4 rng 5117` (§14.7) — exactly.

The themeroom probe covers the 46 closures the reservoir sampling almost never
reaches. On a nine-level wizard game (`--seed 4242`, `playmode:debug`, level
teleport to Dlvl 2–10), all five checks PASS for:

* **all 15 themeroom fills** — Ice room, Cloud room, Boulder room, Spider nest,
  Trap room, Garden, Buried treasure, Buried zombies, Massacre, Statuary, Light
  source, Temple of the gods, Ghost of an Adventurer, Storeroom, Teleportation
  hub;
* **all 31 themerooms** — default, Fake Delphi, Room in a room, Huge room with
  another room inside, Nesting rooms, the three "themed fill" rooms, Pillars,
  Mausoleum, Random dungeon feature…, the four L-shapes, Blocked center, the
  three Circulars, the four T-shapes, both S-shapes, both Z-shapes, Cross,
  Four-leaf clover, Water-surrounded vault, Twin businesses.

Evidence per script, in the form §7.7 uses:

| Script | .lua lines | What it adds | Evidence |
|---|---|---|---|
| `themerms` | 1097 | the only state that outlives its load; reservoir sampling; `des.object()`'s result; obj methods; deferred `postprocess` handlers; 46 closures | **every session** — it is loaded once per game and its generators run on every ordinary level of the main dungeon, so all 69 corpus sessions exercise it; plus the themeroom probe for all 46 closures |
| `hellfill` | 443 | seven level generators; `type()`; a `repeat` over mixed prefabs; `u.invocation_level`; two `hell_tweaks()` | **both** — forced generation at five depth/role settings, and three real generations in `seed4500-knight-coverage`, which is the one corpus session that walks into Gehennom's *filled* levels rather than teleporting to the named ones |

The six-check oracle on `seed0077-rogue-chargen`
(`--readback --questprobe --globals`) reports `library globals: MATCH (6 loads
of nhlib.lua+nhcore.lua+themerms.lua; every global the expected type: yes)` —
the fifteen names `themerms.lua` leaves in the themes state, with the content
hash of `themerooms` (31 entries) and `themeroom_fills` (15) compared against
the interpreter's.

**The 129 earlier ports are unaffected.** All 126 level-script ports still
MATCH forced at Dlvl 1 (nine batches of 14; §11's budget note still applies),
`--readback --questprobe --globals` still reports `read-back table: MATCH` and
`quest-text delivery: MATCH (23882 terminal bytes, firstDiff=-1)`, the tutorial
session (`OPTIONS=tutorial`, Knight) is `PASS` on all of it, and the plain
oracle on `seed0360-wizard-world-tour` still reports `120639/120639`.

### 15.9 The assertion: zero .lua parsed

§14.5 measured what still reached the Lua parser and got
`themerms.lua×1` — or `hellfill.lua×1, themerms.lua×1` with a Gehennom filler
forced. With S7 the same census over **all 69 corpus sessions**, ports live,
reports:

```
sessions: 69  segments: 104
.lua loads intercepted by a port: 987
.lua files parsed by the interpreter: 0
distinct unported names: (none)
distinct ported names (64):
  nhlib.lua x499   dungeon.lua x104  nhcore.lua x104  themerms.lua x104
  quest.lua x80    minefill.lua x8   oracle.lua x6    tut-1.lua x5
  soko1-1.lua x5   tower1.lua x4     hellfill.lua x3  … 53 more
```

**987 loads, zero parses.** Every `.lua` the 69 sessions open is intercepted:
`nhlib.lua` 499 times (one per `nhl_init()`), `themerms.lua` once per game,
`quest.lua` once per delivered message, and 60 level scripts between them.
`sourceCensus()` counts a file only when the interpreter is handed its *real*
bytes, so `distinct unported names: (none)` is the assertion itself and not a
summary of one.

The 64 distinct scripts reached in ordinary or wizard-mode play is up from the
56 §8 recorded after S4: S5's `tut-1`, S6's `nhlib`/`nhcore`, S7's `themerms`
and `hellfill`, and three more level scripts the S7 sweep happened to record.

Two honest qualifications, unchanged from §14.5. The interpreter still
*compiles* something for each ported file — the same-length `--[[ ]]` stub §4
describes, which is an empty chunk — so "never parses any .lua source" is exact
and "never runs the Lua parser" is not. And the interpreter itself is still in
the tree and still running, because it is the differential oracle; removing it
was never the goal.

### 15.10 Negative controls

Six, of which one is the control that found §15.4's bug and one is a control
that **passes** and is the more interesting for it. Every one was reverted.

1. **Reservoir draw order.** `themerooms_generate()`'s loop over `themerooms`
   reversed. The same number of draws — one `nh.rn2(total_frequency)` per
   eligible room either way — in the opposite order, so every room the sampler
   picks changes. `checkChunk` catches it at the first call
   (`rng=low themerooms_generate#1: call count lua=11 js=1`) and the oracle on
   `gen9996-marathon-dlvl10` diverges at `rng firstDiff=313` — inside the very
   first `makerooms()` — with the fingerprint `96cc0eb7` → `4948ba23`.
2. **A theme closure's content, invisible to play.** Temple of the gods:
   `align[1]` and `align[2]` swapped, so the three altars are built in a
   different order. Costs no randomness at all. `rng 24324/24324 firstDiff=-1`,
   `screens 42/42 firstDiff=-1` — **caught only by the fingerprint**
   (`30383567` → `b468f25b`) and, independently, by `checkChunk`
   (`themeroom_fills[12].contents call[704] des.altar.args.0.align:
   "align[1]" != "align[2]"`). This is §5's statue control in its S7 form.
3. **The `postprocess` queue's lifetime.** `post_level_generate()` clears the
   queue *before* draining it instead of after, i.e. the state does not survive
   from `themerooms_generate()` to `post_level_generate()`. The deferred
   handlers never run: `rng 27669/24696 firstDiff=1117`, screens diverge at 0,
   fingerprints differ on all three levels, and `checkChunk` reports
   `post_level_generate: call count lua=909 js=727`.
4. **The kept value's lifetime.** `releaseKeptValues()` moved from
   `post_level_generate` to the end of `themerooms_generate`, so the Garden
   fill's selection is released before `make_garden_walls()` reads it. The game
   **aborts** — the registry slot is gone and `selection.grow` is handed a
   collected value. A loud failure is the right outcome for a lifetime error,
   and it is the reason `keepValue()` is an explicit marker rather than a
   heuristic.
5. **A field invisible to play, in the generated port.** `hellfill.lua`'s
   `populatemaze()`: the minotaurs become peaceful. A peaceful minotaur costs
   exactly the same randomness, so the forced generation spends the same
   **5,117** draws and the fingerprint moves `a67192d4` → `a0c362f`; `--check`
   reports it mechanically as `rng=low call[24] des.monster.args.0.peaceful:
   0 != 1`. (The global RNG log then diverges downstream at 8161, because a
   peaceful minotaur changes the rest of the game.)
6. **The cache lifetime — the control that passed.** The port rebuilt its whole
   world (`makeThemerms(api)`) at the start of every
   `pre_themerooms_generate()`, i.e. per *level* instead of per *branch*. It
   **PASSES**: `gen9996-marathon-dlvl10` `54924/54924`, `17829/17829`,
   fingerprints MATCH, and `seed0360-wizard-world-tour` `120639/120639`.
   That is worth writing down rather than glossing. The chunk's own state is
   effectively re-initialised every level *by the .lua itself* — `postprocess`
   is drained and reset by `post_level_generate()`, `debug_rm_idx` and
   `debug_fill_idx` are recomputed by `pre_themerooms_generate()`, and the two
   big tables never change — so nothing the script holds is observably
   per-branch. What *is* observably per-branch is the **load count**: the
   interpreter loads `themerms.lua` once in a ten-level game, and the oracle's
   load list shows the port running at exactly the same single point
   (`themerms.lua@rng312` on the marathon). Control 3 is what pins the state's
   lifetime *within* a level; the load list is what pins it across levels.

Controls 1, 2, 3 and 5 are also caught by a source-level check that needs no
game at all — two independent detectors, as in every stage since S2.

### 15.11 What remains for the branch

Nothing in the roadmap. What is left is evidence quality, and it is the same
gap §13 has described since S2:

* **Tour-session evidence.** The corpus reaches **64** of the 131 scripts in
  ordinary or wizard-mode play (§15.9's census); the other 67 have synthetic
  evidence only — forced generation or a probe rather than a recorded session
  that reaches them. The cheapest improvement is unchanged: one more
  wizard-mode tour session per role would upgrade quest levels in three tiers
  at once. S7 adds its own version of the same gap: the 46 themeroom closures
  are evidenced by the themeroom probe (§15.5) at one seed and nine depths, and
  a recorded session with `THEMERM` set would be stronger.
* **Merge-to-main readiness.** The branch is green on every gate: corpus 69/69
  twice with the ports live and once with `C2JS_LUA_PORT=0`, the marathon
  session byte-exact against the C recorder (54,924 draws / 17,829 screens),
  `node --test` 6/6, the four `tools/c2js` suites, judge-sim `PASS` with 0
  mismatches and 0 out-of-scope requests, `playability.mjs` on the `xhr` engine
  with `console_entries: []`, and `strict-score --all` clean. The off-switch is
  structural (§4) and is exercised on every corpus sweep. **It is ready to
  merge; this stage does not merge it.** §16 re-establishes all of it against
  a `main` that moved a long way underneath.

---

## 16. Refresh onto main — the resettable realm

The branch forked at `408410b`. `main` reached `8c7b833` with 43 commits, and
three of them changed what a ported script runs *inside*: the whole-program
yieldable build (`js/generated-y/`, `docs/NOTES-async-engine.md`), the resident
main-thread engine, and — the one that matters here — **resettable realms**
(`docs/NOTES-resettable-state.md`): `js/jsmain.js:runSegment` no longer forks a
module graph per segment, it keeps ONE and puts its state back.

Merged, not rebased: the 30 commits are the argument, and their order is the
evidence for it.

### 16.1 The three textual conflicts

| file | what happened |
|---|---|
| `js/boot/isolation.mjs` | Both sides edited `SHARED`. main **fixed** the pattern — `/data/nethackdir/` had matched nothing since the playground moved to `js/data-nethackdir/`, so every fork had been carrying its own 2.1 MB copy — while this branch had **added** `js/lua-js/data/` to the broken spelling. Resolved to the union on main's fixed pattern. |
| `tools/strict-score.mjs` | Both branches had independently added an identical `ALLOWED` map for `js/boot/interactive.mjs`'s `import('node:worker_threads')`, in different surroundings, so git kept **both** — a `const` redeclaration that would not have parsed. One kept. |
| `docs/ROADMAP.md` | Disjoint rows (1.4 from main, 1.10 from here); auto-merged. |

`js/boot/harness.mjs` did not conflict — main never touched it — and neither
did `js/jsmain.js`, which this branch never touched.

### 16.2 The conflict that was not textual

`js/boot/harness-y.mjs` did not exist when this branch started. It is
`tools/c2js/yieldify.mjs`'s mechanical rewrite of `harness.mjs`, so §4's VFS
interception lands in it *automatically* — including
`await import('../lua-js/registry.mjs')`. That import is wrong there, and
silently so.

`js/lua-js/*` drives `js/generated/` directly: `bridge.mjs` imports `lapi.js`,
`sp_lev.js`, `nhlsel.js`, `nhlobj.js`. Reached from a *yieldable* harness those
specifiers resolve into the **sync** graph — and under
`js/boot/reset-realm.mjs`'s `y` fork tag, into a *third* graph tagged like the
yield realm but built from the sync directory. The ports would have pushed
rooms, monsters and traps into a `lua_State` belonging to a graph the game was
not running in; levels would have come out empty, three module URLs from the
cause.

So `yieldify.mjs` grows an **eighth** asserted patch that makes `luaPort` null
in that build. The yieldable engine parses `.lua` exactly as it does on main —
which costs nothing, because "the port and the interpreter are
indistinguishable" is what this entire branch proves. Porting `js/lua-js`
*through* the yield transform is a leg of its own: every binding the ports call
(`lspo_monster`, `pline`, …) is coloured, so the whole port layer would have to
become generators.

`js/generated/` and `js/generated-y/` were rebuilt from scratch
(`C2JS_YIELD=1 C2JS_RESET=1 node tools/c2js/build.mjs --all --force`) and
reproduce main's committed trees **byte for byte**. `js/boot/harness-y.mjs` is
the only file the rebuild changes.

### 16.3 The port layer is state, and a reset realm has to put it back

`js/generated/__reset.js` resets the graph; `js/cptr.js` resets the pointer
runtime. `js/lua-js` is a third layer with the same problem and no emitter to
derive it, so its reset is hand-written: `__resetState()` in `bridge.mjs` and
`interp-state.mjs`, composed by `registry.mjs`, driven by
`js/boot/reset-realm.mjs`.

**Thirteen bindings**, and the differential is what proves the list complete.
With the whole layer's reset skipped and everything else intact,
`tools/reset-diff.mjs --via runsegment` goes to **0/3** and names it:

```
reset:  lua-port nhlib.lua: interpreter lua_State not found
```

That is `interp-state.mjs`'s `installed`. The state probe wraps
`globalThis.realloc`, and `harness.mjs` installs a **fresh** `g.realloc` at the
top of every `runBootGame()`; a flag left true makes game 2's
`installStateProbe()` a no-op, `candidates` stays empty for the rest of the
process, and every read-back port throws. It is loud only because §6 made a
missing `lua_State` a hard error instead of a silent fallback.

**`cstrCache`, the one `docs/NOTES-resettable-state.md` §3 predicted.** It
interns `cptr.lit()` buffers by string, and a buffer object is what `addr()`
hands an id to — and those ids are a `lua_State`'s string-hash seed,
`math.random`'s `seed2`, and the hash that decides `next()` iteration order. It
is cleared. The honest measurement is that leaving it warm and resetting
everything else is **not observable**: `seed8000→seed8000`,
`seed8000→seed4500` and `seed0030→seed0030` all still pass, because
`cptr.lit()` only builds a `Uint8Array` and never takes an address, so a warm
cache changes no id and no byte. Clearing is kept regardless — that argument
depends on `cptr.lit()` staying side-effect-free, and "game 2 re-interns from
empty, exactly as a fresh realm does" depends on nothing.

Two orderings had to be arranged rather than discovered:

* `acquire()` imports `js/lua-js/registry.mjs` **itself**, after the barrel
  (which is what evaluates the graph) and before `captureAll()`. A fresh realm
  evaluates it in precisely that position — `harness.mjs` imports it
  immediately after `unixmain.js` — so the snapshot is of the state game 2 has
  to start from. Only when a barrel exists, and only for the `sync` build.
* `reset()` resets `js/lua-js` **first**, before the barrel overwrites the
  bytes the port layer points into.

And `detach()` gains `luaLoads`: `closeTrace()` returns registry's own exported
`loads` array and the reset empties it in place — §7.2's `__rngLog` aliasing
bug, arriving in the second observable a judge could hold across a reset.

### 16.4 The census, and the sign-off

`tools/c2js/reset-census.mjs --dir js/lua-js` reported **83 declarations, 19
unclassified** when main scouted this branch read-only. It now reports:

```
js/lua-js: 9 modules, 88 top-level declarations
reset plan: 64 declarations to put back, 0 immutable literals to leave alone
--- SIGNED hand-written state (46) — js/lua-js ---
```

Two changes got it there. The scanner reads **flat object destructuring**
(`const { a, b } = f()`), so `bridge.mjs`'s five `makeNhlib` helpers are five
declarations instead of one unreadable line — `js/generated`'s report is
unaffected to the byte, checked by diffing the tool's output against main's.
And `--dir` on a hand-written directory consults a **signed manifest**,
`HAND_WRITTEN`: every declaration that is not an immutable primitive needs an
entry saying either why it cannot change or which function puts it back. An
unsigned declaration and a stale entry both count as unclassified, so the audit
is a diff rather than a memory — the property `RUNTIME_STATE` already had.

`js/lua-js/data/` is shared across forks (`isolation.mjs`'s `SHARED`), which is
only safe if those two tables are read-only. Checked at runtime rather than
argued: deep-freezing both `export default`s before any game and then playing
`seed8000`, `seed0013` (save/restore) and `seed0030` (ten segments) through a
reset realm completes with no write reaching a frozen object — and ESM is
strict mode, so a write would have thrown.

### 16.5 Gates, after the refresh

Ports live and the scored path on the reset realm unless stated.

| gate | result |
|---|---|
| `reset-diff --via runsegment` | **12/12** byte-identical to a fresh realm, incl. both acid tests (`seed0013`, `seed0030`) |
| `reset-diff --via runsegment --force-noop` | **0/12**, as required |
| reset-diff, lua-port reset disabled *(red control)* | **0/3**, first divergence named above |
| corpus `sessions/ sessions-extra/`, reset path | **69/69**, twice (1053+0.61/turn, 899+0.64/turn) |
| corpus, fork fallback (`__reset.js` moved away) | **69/69** (934+1.01/turn) |
| corpus, `C2JS_LUA_PORT=0` | **69/69** (1029+0.66/turn) |
| `.lua` census, all 69 sessions in ONE reset realm | 104 segments, 954 loads intercepted, **0 parsed**, unported names `(none)` |
| `.lua` census, reset vs fork, per session | **69/69 SAME**, zero parsed on both |
| marathon `gen9996-marathon-dlvl10` | **PASS** — 54,924/54,924 draws, 17,829/17,829 screens |
| `tools/lua-oracle.mjs` on the marathon | rng and screens `firstDiff=-1`, fingerprints MATCH, `.lua still parsed: NONE` |
| `node --test test/*.test.mjs` | **6/6** (incl. 145 script transcriptions) |
| `tools/strict-score.mjs` | 503 files from 2 roots (167 in `js/generated-y/`), **0 violations**, sandbox parity OK ×3 |
| judge-sim `run.mjs` seed8000 / seed0013 | **PASS**, 0 mismatches, 0 out-of-scope |
| `playability.mjs` (production) | 243 moves, 2.65 ms/move, first frame 652 ms, **0 console**, 0 out-of-scope |
| `playability.mjs --no-sw` | replay rung, 19.4 ms/move, 1 console line — the 404 the flag itself injects |
| `playability.mjs --their-page` ×3 seeds | 130 moves each, **0 console**, 0 out-of-scope |
| sandboxed `frozen/playability_runner.mjs` | 44 sessions, **0 failures**, 9,096 moves, 3.77 / 3.48 / 3.43 ms/move |
| `reset-census --dir js/lua-js` | 46 signed, **0 unclassified** |

One number needs its context. The corpus `.lua` census reports **954** loads
where §15.9 reported 987; the difference is entirely `dungeon.lua`,
`themerms.lua` and `nhlib.lua`, and it is 7 segments. §15.9 was measured
through `tools/lua-oracle.mjs`, which runs each segment **without carrying
storage**, so a save/restore segment there starts a *new game* and loads
`dungeon.lua` again. Driven the way the judge drives it — one storage handle
per session — those 7 segments restore instead, and a restore does not run
`init_dungeons()`. Reset and fork agree exactly, per session, on all 69.

The sandboxed playability aggregate is against `main` measured on the same
machine in the same hour: **3.41 / 3.34 ms/move**. `docs/NOTES-resettable-state.md`
§7.3's 3.03–3.08 was a quieter machine, not a different build — that rung runs
`js/generated-y/`, which is byte-identical to main's.
