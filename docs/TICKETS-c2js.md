# c2js tickets: C the transpiler gets wrong or refuses

Rule for all of these: the output may be as unidiomatic as it needs to be, and
may look nothing like the C. It must behave like the C.

A ticket closes when its repro matches native C byte for byte and is covered by
`node tools/c2js/test-gates.mjs`, the full regression still passes on both
runners, and NetHack's generated JS has been regenerated.

Status: OPEN, IN PROGRESS, DONE (with commit), or WONTFIX (with the reason).

## Silently wrong or crashes at runtime

These are the most dangerous, because a build succeeds.

### C2JS-001: pointer walking across rows of a 2-D array. DONE (b768f36) (flat byte arrays)
`int m[2][3] = {{1,2,3},{4,5,6}}; int *p = &m[0][0]; p[4]` is 5 in C and 0 in JS,
with no error. The global form fails the same way. A 2-D array becomes nested JS
arrays, so a pointer can't leave its row.

### C2JS-002: pointer to array. DONE (b768f36) (deref of pointer-to-array is a location)
`int (*r)[3] = m; r++; r[0][1]` and `int a[3]; int (*q)[3] = &a; (*q)[1]` throw
`TypeError`. Cause not yet found. NetHack's `char (*s)[QBUFSZ]` (botl.c) works.

### C2JS-003: Csmith array programs crash or differ. DONE (b768f36) (`csmith-test arrays`: 22 same, 2 skipped, 0 failed)
Seeds 2000-2023 with `--no-volatiles --no-volatile-pointers --no-packed-struct
--max-funcs 3 --max-block-depth 3 --no-unions --no-bitfields --no-structs
--no-pointers`: 12 match, 2 time out in C, 4 throw `Cannot create property 'N' on
number`, 3+ have silently different checksums. Cause not yet found.

### C2JS-004: Csmith seed 106 checksum differs silently. DONE (b768f36) (cause: C2JS-039)
Seed 106 with `--no-volatiles --no-volatile-pointers --no-packed-struct
--no-unions --no-bitfields --no-structs --no-pointers --no-arrays`: C checksum
5F9E5971, JS 4FEC8259, first differing global `g_78`.

### C2JS-005: Csmith pointer programs crash. DONE (b768f36) (`csmith-test pointers`: 23 same, 1 skipped, 0 failed; the cause was C2JS-020 and 021)
Seeds 2300-2323 with `--no-unions --no-bitfields --no-structs --no-arrays`: 18
refused (see C2JS-010), 3 crash with `Cannot read/set properties of undefined` or
`Cannot create property 'v' on number`. Re-run after C2JS-010.

### C2JS-006: `sizeof` of a struct with bit-fields. DONE (b768f36) (real bit-field layout; the c-sizes files are gone)
`struct { unsigned a:3; int b:3; unsigned c:1; unsigned char d; unsigned e:12;
unsigned char f:1; }` is 4 bytes in C and 24 in JS, because the port gives each
bit-field its own bytes. Every struct with bit-fields has the wrong size and
offsets, including `obj` (112 vs 216). `#stats` is patched around this with
`c-sizes-darwin.json`, which this ticket should make unnecessary. Anything that
reads a struct's raw bytes through `char *` or a union also sees the wrong layout.

## Refused at build time

Safe, because nothing wrong can ship, but still C that doesn't transpile.

### C2JS-007: Duff's device (case labels inside a nested loop). DONE (b768f36) (unstructured switches lower to the state machine)
`switch (n % 4) { case 0: do { c++; case 3: c++; ... } while (--k > 0); }` fails
with `duff-style nested case label`.

### C2JS-008: compound literals. DONE (b768f36)
`((int[]){3, 4})[1]` fails with `unsupported node kind CompoundLiteralExpr`.

### C2JS-009: anonymous structs and unions as local types. DONE (b768f36)
`struct { int x, y; } pt = { .y = 2 };` fails with `layout: unknown struct`. Same
cause: `union {...} __u` in `<math.h>`'s inline functions.

### C2JS-010: address of a global, in single-file builds and initializers. DONE (b768f36)
`static int g; static int *gp = &g;` fails with `address-of var unsupported (v1)`.
`static int g; int *p = &g; *p = 5;` throws at runtime. `symbols.mjs` computes the
address-taken set only in `build --all`, and the single-file path gates use never
gets it. Build single files with the same analysis, then check whether the
file-scope initializer still fails.

### C2JS-011: reversed subscript. DONE (b768f36)
`1[v]` and `1["abc"]` fail with `subscript on non-pointer/non-array`.

### C2JS-012: `offsetof` written by hand. DONE (b768f36)
`(size_t) &((struct s *) 0)->f` fails with `MemberExpr .f on rep val unsupported`.
The `offsetof()` macro works.

### C2JS-013: other constructs the emitter refuses. DONE
Every refusal is now either handled, or filed with its reason: C2JS-044, C2JS-045, and
inline assembly. Each construct has a program in `fixtures/lang/`. The emitter's remaining
`throw`s are internal checks, or `unsupported` for a type or node none of these reach.

### C2JS-014: Csmith with its remaining features on. DONE (b768f36)
Unions, volatiles, packed structs and full-size programs all pass, 0 failed. What they
found became C2JS-020 to 039.

## Found by the Csmith run and hand-written stress programs

All DONE (b768f36), each with a repro in `fixtures/lang/`. All but 029 and 030
were silently wrong or crashed at runtime. NetHack's sessions never showed them.

### C2JS-020: two different address-taken locals compared equal. `ptw.c`
`cptr.eq` compared `buf` and `off`, and a box has neither, so `&x == &y` was true.

### C2JS-021: a box held the wrong form of a narrow or unsigned value. `mixa.c`
`st1`, `stI16` and `stI32` stored one canonical form regardless of C type, and locals
read `.v` directly. A `signed char` read back 242, and an `unsigned` read back negative.

### C2JS-022: narrow compound assignment through a pointer. `ptw.c`
`*p /= 3` on 8 and 16 bits stored and returned a fraction, and `(*p |= x)` used as a
value wasn't narrowed.

### C2JS-023: compound assignment mixing integer and floating types. `mixa.c`
`int /= double` used integer arithmetic; `double += long long` threw on BigInt mixing.

### C2JS-024: floating to integer casts. `mixa.c`
`(unsigned char)500.0` stayed 500. Casts now follow arm64: out of range saturates at
32 or 64 bits, then narrows, and NaN is 0.

### C2JS-025: backward goto to a label inside a switch. `goto2.c`
The lowering re-ran the switch, choosing the case from its value instead of landing on
the label. `case 2: s=9; goto lab;` went back to case 2. Now the state machine does it.

### C2JS-026: zero-width bit-fields. `pk.c`
`int : 0` read as width "unknown", so it took 4 bytes and an initializer slot. It also
aligns to its declared type under `#pragma pack`. Csmith seeds 2503, 2606, 2713.

### C2JS-027: initializers. `ini.c`, `ini2.c`
`{.c = {1,2}}` on a union stored into the first member. A gap from `[3] = x` shifted
later values in the array fallback. `typedef enum {...} E` wasn't known as an enum.
`char a[3] = "abc"` in a struct wrote its NUL past the array.

### C2JS-028: `setjmp` in the state machine. `sjforms.c`, `sjgoto.c`
A setjmp is now a resumable state: the dispatch loop's catch sets `__pc` back to it.

### C2JS-029: `__int128`. `i128.c`
A BigInt wrapped at 128 bits, stored as two little-endian 64-bit halves.

### C2JS-030: C11 atomics. `boxa.c`
`_Atomic`, `atomic_int` and friends, and `AtomicExpr`. One thread, so each is its
plain read-modify-write.

### C2JS-031: pointer arithmetic on a pointer to a scalar. `boxa.c`
`&x + 1` and back again threw. The moved pointer now sits on the box's byte view.

### C2JS-032: `__builtin___vsprintf_chk`. `types.c`
Had no runtime, so `vsprintf` with fortify on threw.

### C2JS-033: a location with side effects was evaluated twice. `dbl.c`
`v[i++] += 10`, `f()->n++` and `a[rn2(3)] += x` ran `i++`, `f()` and `rn2(3)` twice,
because the emitter writes the location once to load and once to store. Each part with
an effect now goes through a temporary (`holdPlace`).

### C2JS-034: 64-bit `<<` didn't wrap. `lg.c`, `w64.c`
`st ^= st << 13` left a BigInt longer than 64 bits. `%llu` masked it on print, so it
looked right until the next `>>`. Csmith can't find this: its shift macros never overflow.

### C2JS-035: fused multiply-add. `fus.c`
Clang on arm64 turns `a*b + c` into one `fmadd`, which rounds once, and JS rounded twice.
`cptr.fma` is exact (BigInt), and `fusedSum` follows clang's `tryEmitFMulAdd`: through
parens and a negation, not through a cast, not for a product of constants. This also
closes the gap in C2JS-017. Checked bit for bit over 2,000 rows of 45 expression forms.

### C2JS-039: unary minus and `~` on unsigned values. `neg.c`
`-u` on `uint64_t` was a negative BigInt, and `-u`, `~u` on `unsigned` were negative
numbers, so `~u > 5` was false. `-i` for `int i = 0` was JS's `-0`, so `(double)-i`
printed `-0.000000`. This was the cause of C2JS-004 and seed 2605.

### C2JS-037: C names that shadow the emitter's own. `shadow.c`
A local named `u16`, `uchar`, `Math` or `cptr` hid the helper or global of that name. An
address-taken global with a mangled name lost its box.

### C2JS-038: smaller refusals and gaps. `conv.c`, `rec.c`, `mathf.c`
- `case 5 ... 7:` silently lost its body
- `_Bool` with `+=` stayed 2
- an enum declared inside a function had undefined constants
- an anonymous struct or union from a macro expansion was refused
- `struct tm` and other header records were unknown in single-file builds
- <math.h>'s `__inline_*` helpers were missing in single-file builds
- `strftime` copied its format string and returned 0
- `feof` was missing, along with about 70 others: the `*f` and `*l` math family,
  `frexp`, `modf`, `ldexp`, `lround`, `nextafter`, `gmtime`, `asctime`, `strsep`,
  `stpcpy`, `strlcpy`, `atexit`, and clang's `__builtin_*` bit and float functions

### C2JS-040: constructs found by per-feature probes. `fixtures/lang/x_*.c`
One small program per construct, 61 in all. 20 of the first 56 failed at first:
- `__attribute__((constructor))`, `destructor` and `cleanup`
- `atexit` and `exit` running their handlers (standalone runners now go through
  `__standaloneMain`)
- `a ?: b`, `__builtin_choose_expr`, `__builtin_constant_p`,
  `__builtin_types_compatible_p`, `__builtin_offsetof`, and `offsetof` with a member
  path like `a.b[2].c`
- enums wider than int, and named enum pointers
- wide and Unicode strings (`L""`, `u""`, `U""`, `u8""`), `wchar_t`, and `wcslen` and friends
- `<complex.h>`'s `creal`, `cimag`, `cabs`, `conj`, `cexp`, `csqrt`
- multi-dimensional VLAs, pointers to VLA rows, and typedefs inside functions
- flexible array member initializers
- `&"abc"`, empty structs, `1e400`
- a struct type spelled only inside an expression (`sizeof(struct {...})`)
- `for (struct {...} s = ...;;)`, statements before a switch's first label, `switch (x);`

### C2JS-041: `cleanup` in a function with goto labels. DONE (`y_cugoto.c`)
try/finally can't cross the state machine, so in these functions each way out of a scope
gets its calls written in: a goto, return, break, continue, or the end of the block.
Clang rejects a jump into a cleanup's scope, so a goto only ever leaves scopes.

### C2JS-042: a VLA's size after its bound changes. DONE (`vb.c`, `vb2.c`)
C fixes a VLA type's size when the type is declared. A bound that's written later, or has
a call in it, is now captured in a hidden variable at the declaration, and the types of
expressions flowing from that declaration name it. `sizeof(int[n])` also used the bound
as its operand and returned 4. Bounds that never change emit what they did.

### C2JS-043: more found by a second probe batch. DONE (`fixtures/lang/y_*.c`)
- pointers through bytes: `memcpy(&q, &p, 8)`, `union { int *p; long l; }`
- `int g; int g = 3;`, and `int a[]; int a[2] = {...};`
- `main(argc, argv, envp)` in a standalone program, and stdin at end of file
- `scanf` `%f`, `%e`, `%g`; `printf` `%a`, `%n`, `%ls`, `%lc`, `%5%`. Darwin's `%a`
  doesn't round to even: it rounds up past 8, or at 8 if the digit after that is odd
- `alloca`, `mkstemp`, `remove`, `fopen` in append mode, and Darwin's `strerror` text
- `_BitInt(N)`, `__fp16`, `_Float16`, `_Alignof` of a variable with `aligned`
- `__asm__("")`, which does nothing

### C2JS-044: GCC vector types. OPEN (safely refused)
`typedef int v4 __attribute__((vector_size(16)));` fails with `InitListExpr ... unsupported`.
Doable as an element-wise value type, but it's a new kind of value in the emitter.
NetHack doesn't use them.

### C2JS-045: Apple blocks. OPEN (safely refused)
`^(int x) { return x + k; }` fails with `unsupported node kind BlockExpr`. Needs closures
that copy their captures, with `__block` shared. NetHack doesn't use them.

### WONTFIX: inline assembly with instructions
`__asm__("nop")` fails the build. It's machine code for a CPU the JS isn't running on.

### C2JS-046: a `goto` spliced into a loop inside a switch left only the loop. DONE
Introduced by b768f36 and pushed. To support declarations before a switch's first `case`,
`stmt_SwitchStmt` replaced the body with a copy, even when nothing was dropped. The goto
plan is keyed by the original node, so every switch lost its plan, including the labeled
break that a spliced `goto` needs. `fill_zoo`'s `goto throne_placed` then made a second
throne monster on maze-level courts, as in Fort Ludios.

The 171 sessions, the gates and Csmith all passed. Only the wider session set failed, with
7 RNG divergences (knox, forced-arrival, level-reset). Now the copy is made only when items
are dropped, and the plan is looked up on the original node with its indexes shifted.
`fixtures/lang/switch_goto_splice.c` fails without the fix.

## Found by comparing the runtime and startup with the recorder

These came from testing `js/cptr.js`, `js/libc/` and the harness directly against Darwin libc
with hostile inputs, and from recording scenarios that reach text from outside the game. The
first four are reachable by a recorded session. "Uncommitted" means the fix is in the working
tree and passes regression, but has no commit to name yet.

### C2JS-047: the game started with no arguments; the recorder runs `nethack -u <name>`. DONE (uncommitted)
`scripts/record-session.mjs` takes the first `name:` from an `OPTIONS` line and passes it with
`-u`, which overrides whatever the game's own parse of the rc left in `plname`. An rc with
`OPTIONS=name:Sw` and a later `NAME=Foo` greets Sw in C and Foo in JS, on every screen. The
harness now passes the same arguments, using the same parsing rules. `yieldify.mjs` patches
this line of the harness by its exact text, so it changed too.

### C2JS-048: non-ASCII keys, rc text and names were truncated to one byte. DONE (uncommitted)
The recorder writes each UTF-16 unit of `moves` as UTF-8, writes the rc as UTF-8, and passes the
name as UTF-8. It takes one step per byte read, and stops after `moves.length + 1` reads. The
harness masked every character with 0xFF. Keys like `é`, names like `été`, and rc text with
high characters all diverged. The input queue now holds the same bytes, cut at the same point.

### C2JS-049: `opendir`/`readdir`/`closedir` were stubs, so the restore menu never appeared. DONE (uncommitted)
`selectsaved` is on by default, and `tty_askname` calls `restore_menu` when no name is set. So
any session with a saved game and a later segment with no `name:` reaches `get_saved_games`,
which lists `save/`. With `opendir` returning NULL the JS went straight to "Who are you?". All 6
recorded restore-menu scenarios failed. They now read the VFS, with Darwin's `struct dirent`
layout. `rewinddir`, `telldir` and `seekdir` were added as well.

### C2JS-050: the seed was parsed with `BigInt`, not `strtoul`. DONE (uncommitted)
`rnd-prelude.js` read `NETHACK_SEED` with `BigInt()`. A value past 2^64 saturates in C and did
not in JS, which diverged on the first RNG call. The harness defaults for a missing seed and
datetime now also match the recorder's (0 and `20000110090000`).

### C2JS-051: same-named locals in sibling scopes shared one JS binding's type. DONE (uncommitted)
Locals with the same name but different types in one function now get `name__N`. In NetHack this
renames variables only (Lua files, `pickup.js`, `zap.js`).

### C2JS-052: `char x[N] = "..."` took the literal's size, not N. DONE (uncommitted)
Clang types the literal as the array, so comparing those sizes showed nothing. The check now
uses the literal's own length, and `cptr.bytesN` builds the array at its declared size. NetHack
has no such declaration, so its output is unchanged.
`fixtures/lang/char_array_init_sizes.c`.

### C2JS-053: the heapsort path of `darwinQsort` was wrong. DONE (uncommitted)
Reached when quicksort's recursion budget runs out. Whether a real game gets there is unproven;
`sortloot` with a long list is the likely route. `fixtures/lang/qsort_heapsort_path.c`,
`fixtures/lang/rt_qsort.c`.

### C2JS-054: `printf` gaps. DONE (uncommitted)
Positional arguments, `%D %U %O %F`, unknown conversions, a bare `.` as precision 0, values of
1e21 and up, precision over 99, `-0` in `%e`, `#` keeping the point, `%#.o` of 0, sign and zero
padding of inf and NaN, `0` padding `%s` and `%c`, and `snprintf` with n=0. 84,911 output lines
now match. `fixtures/lang/rt_fmt.c`.

### C2JS-055: number parsing set no `errno` and missed forms. DONE (uncommitted)
`strtol` family: EINVAL and ERANGE. `strtod`: hex floats, `nan(...)`, ERANGE. `scanf`: `%L` and
hex floats. Also `atoi`, `atof`, `localeconv`, `pow`'s C99 special cases, `iscntrl(-1)`, and the
full Darwin `strerror` table. `fixtures/lang/rt_scan.c`, `rt_str.c`, `rt_ctype.c`.

### C2JS-056: files had separate read and write buffers. DONE (uncommitted)
A write after `lseek` did not honor the position. Each open file now has one buffer. Also: ENOENT
for a missing parent directory, EINVAL for a negative seek, return values and `errno` for
`access`, `stat`, `unlink`, `rename`, and `fgets` setting EOF at the end of a file. Files are
rewritten only when changed, because `check_recordfile` opens `record` read-write just to test it.

### C2JS-057: `strftime`, `gmtime` and `localtime` gaps. DONE (uncommitted)
`%g %G %V %s %v %+ %z %Z`, the `-_0` flags, unknown conversions, `tm_gmtoff`, `tm_zone`, one static
`tm` buffer as in C, and a real `mktime` for standalone programs. The game's own `mktime` stays
pinned to the recorder's offset. `C2JS-059` lists what is left.

### C2JS-058: `regcomp`/`regexec` cover only NetHack's use. OPEN
NetHack calls `regcomp(REG_EXTENDED|REG_NOSUB)` and `regexec(..., 0, 0, 0)`, and under those flags
a 14,684-line comparison with Darwin's TRE shows no differences. Any other C program can hit
these gaps: basic regexes (no `REG_EXTENDED`), `REG_ICASE`, `REG_NEWLINE`, `REG_NOTBOL`,
`REG_NOTEOL`, `re_nsub` always 0, and `pmatch` never filled. Filling `pmatch` correctly needs
POSIX leftmost-longest submatch rules, which a JS `RegExp` does not follow, so it needs a real
matcher. No effect on NetHack.

### C2JS-059: `mktime` edge cases in standalone programs. OPEN
`rt_time.c` under `TZ=America/New_York` differs on 19 of 1,638 lines: a repeated hour at
1:59:59 (Darwin's binary search lands on standard time there, and on daylight time at 1:00 and
1:30), dates before 1901 (Darwin returns -1), and local mean time before 1883. The standalone
`mktime` also hardcodes offsets of -5 and -4, so other zones are wrong. No effect on NetHack.

### C2JS-060: RNG from bytes past the last recorded step. FIXED
The recorder writes each key as UTF-8 and stops at `moves.length + 1` reads, so a multi-byte key
leaves bytes unread at that point. They are already in the pipe, and C keeps running them until
it is killed: their RNG and file writes land in the recording, their screens do not. The harness
cut its input to `moves.length` bytes, so `'      €   €€.i   '` was 4 RNG calls short. It now reads
every byte and reports at most `moves.length + 1` screens. Tests: `env-key-euro`,
`env-key-euro-two-segments`. Interactive play is exempt from the screen limit.

Two cases stay unreplayable, because they depend on when the kill lands:
- The last keys' RNG can be cut off, and C differs between recordings: the same recipe gave 2512
  and 2519 calls. Within a single segment the JS still passes, as the scorer ignores extra calls.
  With a later segment, one that lost the race fails, as the calls shift it.
- A save in the last keys is killed partway, leaving an empty file, so the next segment opens with
  `Read 0 instead of 1 bytes`. The JS completes the save instead.

### C2JS-061: process and user functions are stubs or missing. OPEN
No implementation: `popen`, `pclose`, `execl`, `execv`, `execve`, `waitpid`, `setuid`, `setgid`,
`environ`. Constant stubs: `system` (-1), `getlogin` and `getpwnam` (NULL), `fork` (42), `getpid`
(4242). The game's recorded paths through these match. A standalone program using them gets
wrong behavior, with no error.

### C2JS-062: fixes from b768f36 to d54cbab are not in the judged `js/`. OPEN
`abf5717` put `js/` back to the Nov 4 build (`ed2c66e`), because the Nov 6 build scored 124
held-out points lower and the cause wasn't found. Everything marked DONE (b768f36),
DONE (5b37c5f), C2JS-047 to 057 and C2JS-060 is therefore missing from `js/` on main, though
the tickets say DONE. Since then two parts have gone back on main: the rc file and screen bytes
as UTF-8 (`455aa9a`, from C2JS-048) and the `nethack -u <name>` launch (`8b7b5ac`). Neither
changed the held-out score. Next, the whole runtime from `d54cbab` (`js/libc/`, `js/cptr.js`,
`js/cjmp.js`, both boot harnesses) went on top of the Nov 4 generated code. On 3,899 local
recordings it turns 8 failures into passes (multi-byte keys and the saved-game menu) and breaks
none. If the held-out score holds, what is left is the regenerated `js/generated*/`.

One that shows up in recordings: the struct sizes printed by `#stats` and wizard mode's memory
screen. Main prints 216 for `struct obj` and 320 for `struct monst`, the port's own sizes,
because bitfields are separate fields (`tools/c2js/build.mjs` `collectBitfieldWidths`). C
prints 112 and 192 on both macOS arm64 and Linux. `d54cbab` prints C's values. Repros: the
`wizcmds.c-wizard-memory-*` sessions, which fail on main and pass on `d54cbab`. Main also prints
`%p` literally where C prints an address; that screen can't match either way (WONTFIX `%p`).

Closes when each remaining part is back on main and the held-out score holds, or the part
that costs points is found and fixed.

## Where C itself depends on the platform

### C2JS-036: arm64 and x86-64 C disagree. Documented; no effect on NetHack
Measured three ways: Darwin arm64 natively, Darwin x86-64 under Rosetta, and Windows
x86-64 (mingw) under Wine. The port matches arm64, where the official sessions come from.

**NetHack, end to end.** The recorder built as x86-64 and run under Rosetta reproduces
all 397 sessions in `sessions/` and `sessions-extra/`: every RNG call, screen and cursor.
The one line that differs anywhere is the recorder's temporary `$HOME` on the `?g` help
screen, which is a path, not a platform effect.

**C language.** Of 162 test programs, 158 print the same on both. The others:

| | arm64 | x86-64 |
|---|---|---|
| `a*b + c` | one rounding (`fmadd`) | two roundings (no FMA in the default target) |
| `sizeof(long double)` | 8, same as `double` | 16, x87 80-bit |
| floating to integer, out of range or NaN | saturates; NaN gives 0 | see below |

Floating to integer is undefined behavior in C when the value doesn't fit, so these are
what each compiler happened to produce, not guarantees:

| Input, cast to `int` / `unsigned` / `long long` / `unsigned long long` / `signed char` / `unsigned char` | arm64 | x86-64 (Rosetta) |
|---|---|---|
| `1e20`, `1e30` | 2147483647 / 4294967295 / LLONG_MAX / ULLONG_MAX / -1 / 255 | INT_MIN / 0 / LLONG_MIN / 9223372036854775808 / 0 / 0 |
| `-1e20` | INT_MIN / 0 / LLONG_MIN / 0 / 0 / 0 | INT_MIN / 0 / LLONG_MIN / 9223372036854775808 / 0 / 0 |
| `3e9` | 2147483647 / 3000000000 / 3000000000 / 3000000000 / -1 / 0 | INT_MIN / 3000000000 / 3000000000 / 3000000000 / 0 / 0 |
| `-1.5` | -1 / 0 / -1 / 0 / -1 / 0 | -1 / 4294967295 / -1 / 18446744073709551615 / -1 / 255 |
| NaN | all 0 | INT_MIN / 0 / LLONG_MIN / 9223372036854775808 / 0 / 0 |
| `300.7` | 300 / 300 / 300 / 300 / 44 / 44 | the same |

On arm64 a cast to a narrow type saturates to 32 bits and then truncates, so `(signed char)1e20`
is -1, not 127. Windows x86-64 under Wine matched the x86-64 column except for
`(unsigned long long)` of `1e20` and `1e30`, which gave 0.

**The one float in NetHack's logic.** `line_dist_coord` in `selvar.c` has
`x = x1 + lu * px`. Over all 4,738,809,600 map coordinates, fused and unfused give a
different point for 2,991,161 of them (0.06%). It's only reachable from Lua's
`selection.gradient`, which none of the 141 shipped scripts call; only
`test/test_sel.lua` does. So a custom script run with `#wizloadlua` could tell the
platforms apart, and a normal game can't.

**libm, last bit.** Disagreements out of 2,000 inputs per function:

| Function | arm64 vs x86-64 | arm64 vs Windows | JS vs arm64 | JS vs x86-64 | JS vs Windows |
|---|---|---|---|---|---|
| `sin` | 409 | 90 | 95 | 352 | 27 |
| `cos` | 405 | 88 | 99 | 346 | 29 |
| `tan` | 146 | 749 | 750 | 763 | 31 |
| `asin` | 22 | 171 | 167 | 167 | 26 |
| `acos` | 16 | 320 | 315 | 317 | 15 |
| `atan` | 10 | 101 | 97 | 93 | 4 |
| `atan2` | 0 | 374 | 377 | 377 | 7 |
| `exp` | 3 | 3 | 180 | 181 | 181 |
| `log` | 0 | 2 | 67 | 67 | 69 |
| `log10` | 0 | 10 | 153 | 153 | 151 |
| `log2` | 0 | 0 | 3 | 3 | 3 |
| `pow` | 2 | 4 | 0 | 2 | 4 |
| `hypot` | 117 | 194 | 694 | 719 | 688 |
| `cbrt` | 2 | 232 | 232 | 232 | 0 |
| `sinh` | 3 | 539 | 539 | 538 | 2 |
| `cosh` | 6 | 445 | 488 | 484 | 179 |
| `tanh` | 8 | 187 | 238 | 236 | 159 |
| `sqrt`, `fmod` | 0 | 0 | 0 | 0 | 0 |

So C has no single answer here. NetHack's C calls none of these except through Lua's math
library, and no shipped script uses them, so the port leaves JS `Math` as it is.

### C2JS-063: a Linux recorder and the macOS recorder disagree. OPEN (documented)
Another team's public recordings (3,447 sessions, made on Linux) were scored against the port.
3,434 pass, 13 fail, and every one of the 13 has the same RNG as the recording. Re-recording the
failing inputs on the macOS recorder gives screens the port matches, except where C prints
memory addresses. So these differences are C on Linux versus C on macOS:

| Input | Linux recorder | macOS recorder and the port |
|---|---|---|
| `AUTOPICKUP_EXCEPTION` with a bad regex | glibc `regerror`: `Unmatched ( or \(`, `Invalid preceding regular expression` | Darwin: `parentheses not balanced`, `repetition-operator operand invalid` |
| `!` (shell escape) | `Unavailable command '!'.` | blank screen (the shell runs) |
| sorted loot list with equal keys (`sortloot-blind-wishes-classify-order`) | combat boots before ornamental cope | cope before boots; likely `qsort` tie order, glibc merge sort vs Darwin's |
| `posixregex` trials | first screen blank | normal welcome screen |
| `#timeout`, `#lightsources` | `<ptr>`: that recorder was patched | real addresses (see WONTFIX `%p`) |

The port follows macOS, as do the public sessions. Which one the held-out sessions follow isn't
known. Of the other ports read, one uses the glibc regex text and four use Darwin's.

## Test infrastructure

### C2JS-017: assignment evaluated its sides in the wrong order. DONE (b768f36)
Clang evaluates a scalar assignment's right side first, then the left side's address
and, for `op=`, its old value. JS goes left to right. So `g |= setg(8)` used the old
`g`, `arr[i] = bump_i()` wrote the old slot, and `a[rn2(3)] = rn2(5)` would draw RNG
in the wrong order. `rightSideFirst` in `emit.mjs` uses a temporary where the two
sides can affect each other. Repro: `fixtures/lang/evord.c`.

The temporaries hold a product's operands, so `f += a * g()` still fuses (C2JS-035).

### C2JS-018: a scalar's bytes depended on its value, not its C type. DONE (b768f36)
A boxed `float` holding 1.0 looked like the integer 1, so `memcpy(&u, &f, 4)` gave 1
and `*(unsigned *)&f` gave 1. Boxes now carry their C type. Repros: `boxb.c`, `pun.c`.

### C2JS-019: `puts`, `putchar`, `fputs` never reached stdout in a standalone program. DONE (b768f36)
They wrote to the game's screen capture, while `printf` wrote to stdout. The gates
now pass a sink, so all of them compare. `printf` also wrote UTF-8 instead of bytes.

### C2JS-015: `js/libc/printf.js` and `string.js` are dead code with tests. DONE (b768f36) (the two modules are deleted; both tests now run against cptr.* and g.*, and found the strcmp bugs listed below)
Nothing imports them, yet `test/printf.test.mjs` and `test/libc-string.test.mjs`
look like they cover the game's libc. They don't. The real one is `g.*` in
`js/boot/harness.mjs` plus `js/cptr.js`, now covered by `test/libc-real.test.mjs`.
Delete the dead code and its tests, or wire them in.

### C2JS-016: Csmith run as a repeatable test. DONE (b768f36)
`node tools/c2js/csmith-test.mjs` has fixed seed classes and reports why each program was
skipped. Last run: 213 same, 25 skipped, 0 failed, and every skip was the native program
timing out or hitting undefined behavior. Fresh seeds outside the fixed set (scalars
7000-7029, pointers 7100-7139, unions 7200-7229, packed 7300-7329, full 3000-3039,
7400-7439, 8000-8039) ran 218 programs, 0 failed, on the code as it stood at each run.

## Fixed in b768f36

Smaller fixes from the same work.

- `unsigned` loaded from memory stayed signed in JS, so comparisons, `/=` and `>>=`
  went wrong past 2^31
- `char`/`short` compared with `unsigned` skipped the conversion
- `x /= u`, `x %= u` and `x >>= n` skipped the usual arithmetic conversions
  (`seed %= 255` in `engrave.c` was one real case)
- `++`/`--` on narrow and unsigned types didn't wrap; `(uchar)++` read as signed
- a 64-bit shift count on a narrower value threw
- `float` was a 64-bit double; floats in unions crashed
- `'\377'` was 4294967295 instead of -1
- unary `+` was refused
- `sscanf`: width on numbers, EOF return, `%i`, `%n`, `%o`, `%h`, set ranges.
  `OPTIONS=glyph:G_fountain/#ff0000` got every screen wrong because of this
- `strtol`/`strtoul`: base and end pointer; `atol` was 32-bit
- `printf`: `%f` ties, zero-padding of negatives, `% d`, `%#x`, `%h`, `%hh`, `%e`,
  `%g`, `%t`
- `#stats` printed the port's struct sizes
- the recorder's `$HOME` now reaches the port on locally recorded sessions
- `strcmp` returned only the sign where Darwin returns the byte difference
- `strcasecmp`/`strncasecmp` lowered non-ASCII bytes with JS rules
- `%p` was printed literally; null is now `0x0`
- `div`, `ldiv`, `lldiv` and header types like `div_t` in single-file builds

## Can't be matched

### WONTFIX: `%p` output
`#timeout` and similar print real addresses from the recording process. A non-null
`%p` prints the port's stable id for the pointer, which can't equal a C address.
