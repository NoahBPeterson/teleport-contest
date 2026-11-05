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

### C2JS-013: other constructs the emitter refuses. IN PROGRESS
Each needs a one-line repro and either support or a reason. From `throw new Error`
in `emit.mjs`.

Done, each with a program in `fixtures/lang/`:
- array declared inside a switch body; switch whose body isn't a compound statement
- `for` with several declarations
- `setjmp` region holding a `break` or `continue` of an enclosing loop
- goto into a loop, and mixed label kinds (`gotomix.c`)
- `_Complex`, VLAs, statement expressions, `_Generic`, `_Bool`, anonymous members,
  `#pragma pack` and `aligned`, integer-to-pointer round trips
- `long double`, which is `double` on arm64 Darwin (`ldbl.c`)
- `setjmp` anywhere, including loop conditions, and `setjmp` with `goto` (C2JS-028)
- `__int128` (C2JS-029) and C11 atomics (C2JS-030)

Still to try:
- `array storage for "..." unsupported`, `InitListExpr on "..." unsupported`
- `sizeof`, `loadFrom`, `storeTo`, field types: any type still unsupported
- the remaining goto throws, which should all reach the state machine now

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

### C2JS-041: `cleanup` in a function with goto labels. OPEN (safely refused)
The goto lowerings don't know a cleanup's scope, so a jump out of it would skip the
call. This now fails the build rather than skipping the cleanup silently.

### C2JS-042: a VLA pointer's row size after its bound changes. OPEN (silently wrong)
`int (*p)[n] = a; n = 5; p[1]` scales by 5, because the row size is recomputed from
`n`. C fixes it when the type is declared. `sizeof` of a declared VLA is already fixed.
Needs a hidden copy of the bound at each declaration of a VLA type.

## Can't be matched without a decision

### C2JS-036: `sin`, `cos`, `tan` and friends differ from Apple's libm in the last bit. OPEN
Measured on 2,000 inputs each, bit for bit, JS `Math` against Apple's:

| Differ | Functions |
|---|---|
| 0% | `sqrt`, `pow`, `fmod` |
| under 2% | `log2` (0.3%) |
| 3-10% | `log` 3.8, `sin` 5.0, `cos` 5.2, `atan` 5.1, `exp` 8.5, `asin` 8.4, `log10` 7.1, `acosh` 6.1, `asinh` 9.9, `log1p` 9.6, `expm1` 9.9 |
| 10-25% | `cbrt` 10.6, `tanh` 11.4, `atanh` 14.6, `acos` 15.8, `atan2` 18.8, `cosh` 23.0 |
| over 25% | `sinh` 27.4, `tan` 36.6, `hypot` 35.8 |

Against exact values, on 600 inputs, Apple's are correctly rounded this often: `log`
and `sinh` 100%, `exp`, `log10`, `cosh` 99.8%, `sin` 96.5%, `cos` 95.8%, `cbrt` 94.8%,
`tan` 61.7%. So correct rounding would get `exp`, `log` and the hyperbolics to about
99.8%, but no further. An exact match needs Apple's algorithms.

This doesn't affect NetHack: its C calls none of these, and no Lua script it ships uses
`math.sin`, `exp`, `log` or the like.

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
