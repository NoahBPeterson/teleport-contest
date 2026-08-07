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

Status: **PoC + S1 + S2 + S3 landed.** `oracle.lua`, `dungeon.lua`, `quest.lua`,
the whole 49-file T0 tier and S3's 28-file T1 tier are ported and live —
**80 of 131 files, 58.9 % of the corpus by bytes**. The corpus passes with the
ports enabled and with them disabled.

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

> **Superseded in S2, and again in S3.** The fingerprint now covers every
> *content* field of `struct rm` and several more object and monster fields
> (§7.5), and the container and monster-inventory chains (§11.3). The hashes
> quoted in the rest of this section are the S1 values and no longer reproduce;
> the reasoning does.

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

> **Superseded in S3.** Even this only sweeps the *floor*. §11.3 widens it to
> the two chains a floor sweep cannot reach — `obj->cobj` and
> `monst->minvent` — which is where the whole T1 tier puts its interesting
> objects.

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

Every session exercises `dungeon.lua` and `quest.lua`; `gen9996-marathon-dlvl10`
also reaches the Oracle level. It scores `RNG 54924/54924, Screen 17829/17829`
in every configuration, i.e. the ports are byte-exact against the **C recorder**,
not merely against the JS interpreter. After S2 the corpus additionally
exercises 16 T0 level scripts in real play (§7.6), and after S3 16 T1 ones
(§11.6) — the five tour sessions now drive 32 ported level scripts between
them and score `RNG 120639/120639` (`seed0360`), `53865/53865` (`seed0361`),
`50125/50125` (`seed0367`), `35386/35386` (`seed0373`) and `108275/108275`
(`seed4500`).

Registering 77 generated ports costs nothing measurable — small modules
imported once per replay segment, and the per-turn slope is unchanged.

Other gates: `tools/c2js/test-rnd.mjs`, `test-hacklib.mjs`, `test-setjmp.mjs`,
`test-union.mjs` PASS; `node --test test/*.test.mjs` 6/6 (posix-ere, the
`lua-port-data` transcription check and the `lua-port-scripts` call-stream
check, now 77 scripts × 8 RNG settings); judge-sim
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
itself evidence about which tier the script is in. The supported subset is:
literals, long strings, table constructors, `a.b`, `a[k]`, `a:m(…)`, nested
calls, `..`, `#`, `local`/global assignment, `if … then … elseif … else … end`,
`function() … end` closures, and nhlib's `percent`/`shuffle`/`d`/`math.random`.
The refused set is `for`, `while`, `repeat`, `and`/`or`/`not`, comparisons and
the selection operators `|`/`&`/`~`.

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
| **S2** *T0 level scripts* ✅ | 49 T0 files: `soko2-1 … soko4-2`, `air/fire/water/earth`, `baalz`, `minetn-6`, `tower3`, `tut-2`, 34 quest `*-goal/-loca/-fil*` | 49 | **Landed — see §7.** Cost 1 leg, not 6, because the transliteration is generated (§7.1) and reachability turned out to be half-solved already: forced generation (§7.6) covers everything, and the corpus's wizard-mode tour sessions reach 16 of the 49 in real play. Note the tier list here was slightly wrong: `soko1-1`/`soko1-2` have a `for` and a `math.random`, so they are S4's, and `minetn-6` is T0. Three things the tier score did not predict, all in §7.3: nhlib's `align`, `monkfoodshop()` and `nh.eckey`. | 6 → 1 |
| **S3** *T1: branches, shuffles, closures* ✅ | 28 T1 files: the 10 `*-fil{a,b}` closure levels, 7 `*-strt` quest homes, `Mon/Pri/Sam-goal`, `soko1-1/2`, `minend-1/2/3`, `castle`, `juiblex`, `sanctum` | 28 | **Landed — see §11.** Cost 1 leg, not 4, for the same reason S2 did: the transliteration is generated. The tier list here was right in kind and wrong in detail — `fakewiz1/2` and `wizard2` call nhlib's `hell_tweaks()`, which is selection algebra, so they moved to S4; the six `*-strt` levels with a `for` moved with them; `soko1-1/2` moved *in* (S2's note that they have a `for` was wrong — they have one `if percent`). The stage's real work was two things §7 did not have: a `--check` that shares one RNG with the .lua so branch and shuffle draws are compared too (§11.1), and a fingerprint that follows `obj->cobj` and `monst->minvent` (§11.3), without which a whole class of this tier's content is invisible. | 4 → 1 |
| **S4** *T2 with real logic* | `minetn-1/2/3/4/5/7`, `medusa-*`, `bigrm-*`, `astral`, `knox`, `valley`, `orcus`, `Wiz-loca`, `minefill`, `tower1/2`, `wizard1/2/3`, `fakewiz1/2`, `asmodeus`, `Kni-strt`, `Bar-strt`, `Mon-strt`, `Pri-strt`, `Rog-strt`, `Val-strt`, `Tou-goal/loca`, `Val-goal`, `oracle` ✅ | 34 | Loops, and selection algebra. First real use of `selection.*` handles through the bridge — `LuaValue` exists but is only smoke-tested; expect a leg of bridge work for selection operators (`\|`, `&`, `~`) and `:iterate(closure)`. Nine of these (the Gehennom levels and `fakewiz1/2`) also need nhlib's `hell_tweaks()`, which is a *library* function with its own RNG, so it has to be ported alongside them. Mines levels are corpus-reachable, which makes this the best-tested stage after S2. | 6 |
| **S5** *tutorial* | `tut-1`, plus the tutorial half of `nhlib` | 2 | The only string-pattern code in the corpus (`s:match("^^([A-Z])$")`) and the only place `nh.eckey` interpolation matters. Self-contained and never reached in normal play, so low risk and low value — do it late, or not at all before the freeze. | 1 |
| **S6** *the libraries* | `nhlib.lua`, `nhcore.lua` | 2 | The hard ones, and the ones that change the load-time RNG contract. Porting `nhlib` moves the `align` shuffle into JS and requires the bridge to own per-state library state; porting `nhcore` requires reproducing `pairs()` order over a string-keyed table and `_G[k]` dispatch — and §6.2 now says what that costs: `pairs()` order over a hash part is a function of `g->seed`, which the port cannot control, so a `nhcore` port has to make the dispatch order independent of it (or the current interpreter behaviour has to be shown independent of it first). Both are read-back *and* executable, so they need §9's two recipes at once. **Only worth doing if S1–S4 land comfortably before the freeze**; the interpreter running two small library files costs nothing in the Phase-1 baseline. | 3 |
| **S7** *themed rooms* | `themerms.lua`, `hellfill.lua` | 2 | 46 KB, 122 functions, frequency-weighted reservoir sampling, deferred post-process callbacks, and the *only* long-lived level-gen state (`gl.luathemes[dnum]`, cached per branch and never closed). `themerms` runs on essentially every ordinary level, so a mistake here is a corpus-wide failure rather than a one-level one — but that also means the corpus tests it hardest. Highest value in a Phase-2 diff (themed rooms are the most likely thing to change in 5.1) and highest risk. | 4 |

Total ≈ 26 agent-legs as first estimated; S1, S2 and S3 came in at 1 leg each
instead of 2, 6 and 4, so the remaining estimate is ≈ 14. S1–S4 (114 scripts,
~87 % of the file count) is the sensible pre-freeze target; S6/S7 only if that
lands early.

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

## 12. Biggest risk to full coverage

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
