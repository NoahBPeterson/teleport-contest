# Reading this port

This is NetHack 5.0 in JavaScript. Almost all of the game is the original C
source, translated function by function by a transpiler (`tools/c2js`). The
names, the control flow and the C comments are the original ones. To find how
a rule works, read the same function you would read in the C.

## Where things are

| You want | Read |
|---|---|
| A game rule (combat, digging, traps, prayer, shops, ...) | `generated/<file>.js`, where `<file>.c` is the NetHack source file. Example: `onscary()` from `monmove.c` is in `generated/monmove.js`; `dighole()` from `dig.c` is in `generated/dig.js`. |
| The monster table (`mons[]`, from `monst.c`) | `generated/monst.js`, one block per monster, in `mons[]` order, starting at the line `cptr.stPtro(mons_init, <offset>, __s_<name>)`. Search for the monster's name. |
| The object table (`objects[]`, from `objects.c`) | `generated/objects.js`, one block per object, the same way. |
| An enum value or `#define` constant (`PM_TITAN`, `SCR_SCARE_MONSTER`, `AD_FIRE`, `MZ_HUGE`) | `generated/nhconst.js` (enums, as `NHC.<name>`) and `generated/nhmacro.js` (object-like macros, as `NHM.<name>`). |
| A function-like macro (`is_rider(ptr)`, `Blind`, `Levitation`) | `generated/nhmacrofn.js` and `generated/nhprop.js`. Most macros are called by name; some are expanded in place (see below). |
| Global game state (`u`, `flags`, `svl`, `gm`, ...) | `generated/decl.js`. The names are NetHack 5.0's own (`u` is the hero; `svl` holds the current level, whose `levl[x][y]` is `svl.level.locations[x][y]`). |
| Text files the game reads (rumors, oracles, epitaphs, engravings) | `data-nethackdir/` (packed copies of NetHack's `dat/` files). |
| Level, dungeon and quest descriptions (the `dat/*.lua` scripts) | `lua-js/scripts/` (`dungeon.mjs`, `quest.mjs`, `oracle.mjs`, ...): each `.lua` file ported to JS by hand, with its C callers named in the comments. |

The rest is not the game:

- `cptr.js`, `cmachine.js`, `cjmp.js`, `libc/`: C's memory model, integer types,
  `setjmp`/`longjmp` and the C library.
- `boot/`: starts the game, provides files, the terminal and the keyboard.
  `boot/harness.mjs` is the replay harness the judge runs.
- `generated-y/`: the same game rewritten so that it can pause for a key in a
  browser (every function that can reach `getchar()` is a generator). It is a
  mechanical copy of `generated/`; read `generated/` instead.

## How C reads in JS

The game's memory is C's memory: structs are bytes, and a pointer is a buffer
and an offset. So a field access is a load or store at a named offset.

| C | JS |
|---|---|
| `mtmp->iswiz` (1-bit field) | `cptr.ldI32o(mtmp, $monst_iswiz) & 1` |
| `mtmp->data` | `cptr.ldPtro(mtmp, $monst_data)` |
| `ptr->mlet` | `cptr.ld1so(ptr, $permonst_mlet)` (`1s` = signed byte, `1u` unsigned, `I16`, `I32`, `I64`, `Ptr`) |
| `mtmp->mhp = 5` | `cptr.stI32o(mtmp, $monst_mhp, 5)` (`st` = store) |
| `&mons[PM_ANGEL]` | `cptr.add(mons, NHC.PM_ANGEL, $sizeof_permonst)` |
| `a == b` for pointers | `cptr.eq(a, b)` |
| `levl[x][y].typ` | `cptr.ld1so3(svl, x, $sizeof_rm_x21, y, $sizeof_rm, $instance_globals_saved_l_level + $rm_typ)` (`o2`/`o3` take one or two array subscripts) |
| `"Elbereth"` | `cptr.lit("Elbereth")`, hoisted to a constant such as `__s_elbereth` at the top of the file |
| `x ? 1 : 0` on a `boolean` | `schar(...)` around it: C's `boolean` is a signed char |

`$monst_iswiz` and the other `$struct_field` names are the field offsets, from
`generated/nhfield.js` (`FLD.monst_iswiz`), bound once at the top of each file.
`$sizeof_<struct>` is `sizeof(struct <struct>)`.

Return values follow C: `TRUE`/`FALSE` are `1`/`0`.
