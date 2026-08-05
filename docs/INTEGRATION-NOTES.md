# c2js integration notes — booting the transpiled game (handoff)

Scope: `tools/c2js/` clang-AST→JS transpiler is done and proven (rnd/hacklib
differential parity, setjmp/union gates, varargs, goto lowerings, 167/170
corpus files transpile clean). Current goal: boot `js/generated/*` under
`js/boot/boot.mjs` and render seed8000-tourist-starter's first screen
identically to the C recording, then rewire `js/jsmain.js` runSegment to the
transpiled game (runner contract: `frozen/ps_test_runner.mjs`).

Hard constraints: no commits; never edit `js/generated/*` (they regenerate);
fix gaps in the emitter (`tools/c2js/emit.mjs`, `symbols.mjs`, `build.mjs`) or
runtime layer (`js/cptr.js`, `js/cjmp.js`, `js/cmachine.js`,
`tools/c2js/runtime/*-prelude.js`, `js/boot/`); keep all seven suites green
(`test-rnd.mjs`, `test-hacklib.mjs`, `test/cmachine.test.mjs`,
`test/libc-string.test.mjs`, `test/printf.test.mjs`, `test-setjmp.mjs`,
`test-union.mjs`); rebuild with `node tools/c2js/build.mjs --all --force`
(~15s warm, ~65s when symbols.mjs bumps the IR cache); log every gap in
`.cache/c2js/boot-log.md`.

## 1. State of boot

`node js/boot/boot.mjs 8000 20260401090000 '  '` currently dies inside
`initoptions` while parsing the session nethackrc (`OPTIONS=...align:neutral`):

```
Program initialization has failed.
Report error to "wizard".
bad index roleoptvals[3][NaN]
[boot] error: ReferenceError: backtrace is not defined
    at NH_panictrace_libc (js/generated/report.js:375:5)
    at panic (js/generated/end.js:473:9)
    at getoptstr (js/generated/options.js:6391:5)
    at parse_role_opt (js/generated/options.js:11225:22)
    at optfn_alignment (js/generated/options.js:6452:14)
    at parseoptions (js/generated/options.js:6309:84)
```

Root cause (diagnosed, not yet fixed): `go.opt_phase` is an
`enum option_phases` field (decl.h:729). `expr_MemberExpr`
(tools/c2js/emit.mjs ~line 543) treats any field whose `parseType` class is
`record` as a record *location*, and `parseType('enum option_phases')` says
`record` — so `getoptstr(optidx, go.opt_phase)` emitted
`getoptstr(optidx, cptr.add(go, 520))` (address) instead of
`cptr.ldI32(cptr.add(go, 520))` (value). The panic then crashes on the
unshimmed Darwin `backtrace(3)`.

Everything before that works: early_init (crashreport stub, decl/objects
globals init, runtime_info_init incl. version/mdlib strings), choose_windows
("tty" → windowprocs vtable populated), RNG seeding via `NETHACK_SEED=8000`,
sysconf parse, reset_commands, condopt qsort, symbol-set init, sysconf +
~/.nethackrc config file discovery.

## 2. Shim inventory (all in `js/boot/boot.mjs` unless noted)

- **argv**: `char *argv[2] = { "nethack", NULL }` built with `cptr.stPtr`
  slots, passed to generated `main(1, argv)`.
- **env table**: `getenv/setenv/unsetenv` over an `ENV` map: `TERM=ansi`,
  `HOME=<mkdtemp>`, `NETHACKDIR=/tmp/c2js-nethackdir` (symlink to the real
  install dir — **required**, `nh_getenv` rejects values >128 chars and the
  real path is longer), `NETHACK_FIXED_DATETIME`, `NETHACK_RNGLOG=memory`,
  `NETHACK_SEED=<argv seed>`. The session segment's `nethackrc` is written to
  `$HOME/.nethackrc` (runner feeds it the same way).
- **process**: `exit` (throws `{__bootExit}`), `abort`, `getpid/getuid/
  geteuid/getgid`, `umask`, `__error` (Darwin errno accessor, returns
  4-byte buffer ptr), `strerror`.
- **passwd**: `getpwuid/getpwnam` → null (whoami falls back, matching the
  harness expectation).
- **signals**: `signal/setsignal/sethanguphandler` no-ops.
- **FS overlay**: reads fall through to the real install dir, writes land in
  an in-memory `Map`. `currentDir` + `resolveP` (chdir is tracked — the game
  chdirs to NETHACKDIR then uses relative paths like `sysconf`/`record`).
  POSIX `open/read/close/lseek` over the fd table, `O_CREAT` creates in the
  overlay; `access/stat/lstat/fstat/chmod/unlink/mkdir/link/rename/rmdir/
  opendir/readdir/closedir/flock/fcntl/chdir/getcwd`.
- **stdio FILE***: `fopen/freopen/fclose/fread/fwrite/fseek/ftell/rewind/
  fgets/fputs/fputc/putchar/puts/fflush/fgetc/getc/ungetc/vfprintf/vprintf`;
  `stdout/stderr/__stdinp` objects plus `__stdoutp/__stderrp` (Darwin stdio
  names — generated code references `__stdoutp` directly).
- **tty**: `ioctl` (TIOCGWINSZ → 80x24), `isatty`, `tcdrain`, `tcgetattr/
  tcsetattr`, `cfgetispeed/cfgetospeed`.
- **time**: `time` (frozen to the session datetime), `localtime` (struct tm
  layout), `mktime`, `difftime`, `strftime`, `clock`, `sleep/usleep`.
- **termcap**: `setupterm/tigetstr/tigetnum/tigetflag/tputs/tgoto` (the
  ANSI_DEFAULT build uses the hardcoded escape table; these are mostly
  belt-and-braces).
- **libc numeric/string**: `atoi/atol/atof/abs/labs`,
  `strcmp/strcasecmp/strncasecmp`, ctype family
  (`isspace/isdigit/isalpha/isalnum/islower/isprint/ispunct/iscntrl/toupper`).
- **CommonCrypto**: `CC_MD4_Init/Update/Final` stubs (crash-report build id
  only; return 1, zero digest).
- **clang fortified builtins** (bare refs corpus-wide, resolve via
  globalThis): `__builtin_expect`, `__builtin_object_size` (→ -1n),
  `__builtin_huge_val`, `__builtin___memset_chk` (box-aware: zeroes `.v` on
  boxed scalars), `__builtin___strncpy_chk`, `__builtin___strncat_chk`,
  `__assert_rtn` (throws with expr/file/line).
- **rng seeding**: `tools/c2js/runtime/rnd-prelude.js`'s `sys_random_seed`
  honors `NETHACK_SEED` (like the recorder's unixmain.c) and throws when
  unset (protects the parity driver).
- **debug aids (temporary, marked)**: `__trace` throttled shim-call log in
  boot.mjs; `__wdTicks` watchdog counters in `js/cptr.js`
  (add/ld1s/st1/ld1u/ldI32/ldU64/ldPtr/strlen/strcpy/cstr/sprintfCore) plus a
  `strlen` runaway tripwire (>1e6-byte scan throws with a live stack). Strip
  or gate these before any perf measurement.

## 3. The two systemic representation classes

All boot blockers so far trace back to two classes. Both are now handled
**centrally in the emitter** — the pattern that worked.

### Class A: obj-model vs byte-model for record storage

`decl.c`'s record globals (`u`, `iflags`, `flags`, `gy`, `gu`, `windowprocs`,
…) and record arrays were byte-packed `cptr.alloc` in their defining TU but
accessed cross-module as plain JS objects (props), so nested fields were
never materialized and `decl_init`'s memset/memcpy wrote bytes nobody read.

Central fix (done): `symbols.mjs` collects `recordGlobals`/`recordArrays`
per TU (record-typed file-scope VarDecls, enum-aware, `volatile` stripped,
typedefs resolved via the shared `desugar`); `build.mjs` unions them and
passes them to every `Emitter`; `DeclRefExpr`/`emitLValue` give cptr rep
with a type-aware `localNames` shadow guard. `NEARDATA`'s `volatile struct
window_procs windowprocs` needed the qualifier strip. Watch:
`enum`-typed *fields* still misclassify as record locations (the current
crash) — exclude `isEnumType` in `expr_MemberExpr`'s record-location
condition.

### Class B: arrays whose storage wasn't byte-addressable

- **Pointer arrays** (`char *x[N]`, fn-ptr arrays): were plain JS arrays,
  but `ldPtr/stPtr` need 8-byte registry slots. Central fix (done): the
  `emitBytePackedArray` helper in emit.mjs emits `cptr.alloc(n*sz)` +
  per-element `stPtr`/`storeTo`/`recordInitStores` for top-level, local, and
  function-static arrays; `subscriptLoc` scales by real element size;
  symbols.mjs collects them corpus-wide.
- **Int/short/long/enum arrays** (`cond_idx[36]`): were plain JS arrays of
  numbers — silently corrupted by byte-generic `memcpy`/`qsort`
  (`nh_deterministic_qsort` in botl/insight/makemon). Central fix (done):
  same helper, all scalar elems >1 byte are byte-packed.
- **Multi-dim arrays**: `arrayParts` peeled the *trailing* bracket, so 2-D
  subscripts scaled by the transposed stride (`gs.sym_customizations[i][j]`
  read a pointer at the wrong offset). Central fix (done): `arrayParts`
  peels the *first* bracket (also covers fn-ptr arrays like
  `int (*move_funcs[10][3])(void)`, whose brackets sit inside parens); 2-D
  arrays get JS arrays of byte-rows (`arr[i]` row selection stays JS),
  with per-element init stores for pointer/int/enum/record elems.
- **char arrays with string-literal init** at top level were bare `__sl`
  CPtrs so `decay()` double-wrapped → now `cptr.bytes()` (done).
- **Static per-TU arrays in headers** (`artilist.h`'s `artilist`/
  `artifact_names`, `sfmacros.h`): filtered from slim IRs as non-main-file →
  `EXTRA_MAIN` in symbols.mjs (artifact, mdlib, sfstruct, sfbase) (done).
- **Stale prelude files**: the batch used to *skip* prelude-proven files
  (rnd/hacklib/isaac64), leaving an obj-model-era hacklib.js in the import
  graph (caused a 99%-CPU hang). Now refreshed with the current emitter,
  prelude included (done). Note: `--force` is parsed but unused — pass 2
  always re-emits.

**Honest recommendation**: every whack-a-mole instance so far turned out to
be one of these classes with a single central fix. Do not patch individual
sites. The remaining known class-level items: (1) enum-typed struct fields
emitted as address-not-load (current crash — fix the `expr_MemberExpr`
record-location condition and audit `loadFrom`/`storeTo` callers for the
same `parseType(enum)→record` trap); (2) by-value struct params are passed
by reference (not yet hit, will corrupt the caller's struct when a callee
mutates); (3) memset-on-boxed-scalar is approximated in the shim (zeroes
`.v`), revisit if a boxed `char[?]`-ish scalar appears; (4) add a batch
post-pass lint for `)<cptr-call>++` / `cptr.add(...) =` invalid-LHS patterns
— `node --check` does NOT catch them (runtime ReferenceError, not syntax).

## 4. Boot path checklist

Boot order (sys/unix/unixmain.c main()): early_init → rng_log_init →
initoptions → whoami → process_options → init_nhwindows → set_playmode →
plnamesuffix → dlb_init → vision_init → getlock → restore_saved_game →
player_selection → newgame → moveloop.

| stage | status | notes |
|---|---|---|
| module init (167 files link) | DONE | export/TDZ/import-cycle issues fixed (decl.js is a leaf via IMPORT_SKIP of raw_printf) |
| early_init | DONE | crashreport stubbed; decl/objects globals init; runtime_info_init (was the strlen hang: stale hacklib.js + opt_indent decay bug) |
| choose_windows("tty") | DONE | windowprocs memcpy works (volatile-qualType fix); def_raw_print fallback live |
| rng_log_init + RNG seed | DONE | `NETHACK_SEED` honored; rnd.js parity suites still green |
| initoptions: sysconf | DONE | opens via short-symlink NETHACKDIR; parse OK |
| initoptions: condopt/symbols/reset_commands | DONE | qsort byte-packing, 2-D transposes, enum counter reset (wEnums2 didn't reset per EnumDecl — CONDITION_COUNT was 36 not 30) |
| initoptions: nethackrc parse | **DYING HERE** | enum-field address-not-load in getoptstr (see §1) |
| whoami / process_options | not reached | getpwuid→null fallback ready |
| init_nhwindows / term_startup | partially exercised | raw_print warnings already render through ANSI table + nomux buffer; full startup not reached |
| dlb_init (data.lbd) | not reached | fopen/fread overlay should work; watch struct-read paths |
| player_selection | not reached | nethackrc sets role/race/gender/align/name → should be non-interactive |
| newgame → moveloop | not reached | input queue (2 spaces) built but the tty_nhgetch/getchar consumer is NOT wired — check how generated getline/tty input reads (likely `read(0,…)` → fd 0 missing, or `getchar` unshimmed) |
| first screen capture | not reached | `nomux_capture_screen()` (termcap.c, tmux -e wire format) unverified against session `step.screen` |

## 5. Next blockers (ordered)

1. **Enum-typed struct fields load as address** — `js/generated/options.js:11225`
   (`getoptstr(optidx, cptr.add(go, 520))`). Fix centrally in
   `tools/c2js/emit.mjs` `expr_MemberExpr` (~line 543): the record-location
   condition must exclude `isEnumType(fieldQ)`; audit the matching
   `emitLValue`/`storeTo` paths. Expect more instances corpus-wide.
2. **`backtrace` shim** — js/generated/report.js:375 (`NH_panictrace_libc`).
   Without it every panic masks the real error behind a ReferenceError.
   Shim as a no-op (or return 0 frames) in boot.mjs.
3. **init_nhwindows / term_startup libc gaps** — expect a few more bare
   libc names (watch for `getchar`/`read(0)`/select/poll for input).
4. **Input wiring** — `inputQueue` in boot.mjs has no consumer yet; trace
   the generated tty input path (win/tty getline/tty_nhgetch) and wire the
   queue to it. Session moves for seed8000 segment 1: `llnjhhykbli\x1b+\x1b\\\x1b\x18  ss:`.
5. **dlb_init / data files** — `data.lbd`, `dungeon`, `options` file reads
   through the overlay; watch for `fread` into record buffers and `fileno`.
6. **First screen** — call `nomux_capture_screen()` at the input boundary
   and diff against `sessions/seed8000-tourist-starter.session.json`
   `steps[0].screen`; RNG log from generated rnd.js prelude vs
   `tools/rng-diff.mjs`.
7. **jsmain rewiring** (after first screen): skeleton js (js/allmain.js,
   cmd.js, display.js, gstate.js, rng.js, input.js, options.js,
   game_display.js, statedump.js — NOT frozen js/isaac64.js, js/terminal.js,
   js/storage.js) moves to `js/skeleton/`; implement runSegment in
   `js/jsmain.js` driving the boot harness machinery; verify
   `node frozen/ps_test_runner.mjs sessions/seed8000-tourist-starter.session.json`.

## 6. Process lessons

Worked:
- **Boot diary discipline** — one line per gap (symptom→cause→fix) in
  `.cache/c2js/boot-log.md`; suites re-run after every emitter change.
- **Throttled shim tracing** (`__trace` on getenv/open/fopen/chdir/exit) —
  the last traced call before a spin pinpoints the stage instantly.
- **v8 `--prof` tick log** for the 99%-CPU hang: writes samples *live*
  (unlike `--cpu-prof`, which only flushes on clean exit and gave nothing);
  `--prof-process` showed `cptr.strlen` hot with the full JS call chain into
  `opt_out_words`. This was the decisive tool.
- **Runaway tripwires**: a single `strlen` call scanning past a buffer end
  never trips per-entry watchdogs — a >1e6-byte scan tripwire with a live
  stack did. Per-entry `__wdTicks` counters in hot cptr functions are the
  second line.
- **Central-over-local fixes**: every instance bug was a representation
  class; one emitter fix closed all sites at once. Diagnosis cost >> fix
  cost.

Didn't work:
- macOS `sample` on the node pid — only C++ frames even with
  `--interpreted-frames-native-stack`; no JS symbols. Skip it.
- `node --cpu-prof` + SIGINT/SIGTERM — profile is written only on clean
  exit; got nothing.
- `cmd | tail` for boot runs — tail buffers everything (empty logs on
  kill), and `kill $BPID` kills the bash wrapper, not node; leftover
  spinning node processes accumulated. Write to a file and `pkill -f
  'node.*boot.mjs'` instead.
- Chasing per-site fixes before recognizing the class — the obj-model
  fallback for cross-module record globals produced plausible-looking but
  unproven code corpus-wide (nothing had executed it before boot).
