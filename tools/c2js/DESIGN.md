# c2js — clang-AST→JS transpiler design (working draft)

Goal: bit-exact, readable, JSDoc-typed ES6 JS from NetHack 5.0 C +
vendored Lua 5.4.8 C. Byte-exact behavior against the clang/LP64
recorder build; source-isomorphic output for Phase 2's parity÷diff
scoring.

## Pipeline

```
foo.c
  └─ clang -Xclang -ast-dump=json (pinned flags, per-file)      [tools/c2js/ast-dump.mjs]
       └─ IR: main-file decls only, resolved types              [tools/c2js/ir.mjs]
            └─ emit: per-construct templates → .js              [tools/c2js/emit/*.mjs]
                 └─ runtime: js/cmachine.js + js/libc/*.js      [hand-written, once]
```

Determinism: same input + same transpiler commit → byte-identical
output. No hash-order emission, no timestamps. Every emitted file
carries a provenance header (input sha256, transpiler version) —
credit: serteal's c2js pipeline for the header idea.

## Target ABI (pinned — matches the recorder, macOS LP64 clang)

| C type | JS representation |
|---|---|
| char (signed here), short, int | number + i32/schar/i16 coercion |
| unsigned variants | number + u32/uchar/u16 coercion |
| long, long long (64-bit) | BigInt + i64/u64 wrap |
| float | number, Math.fround at stores |
| double | number (exact) |
| pointer | see memory model |
| `unsigned long` seed in init_isaac64 | 8 little-endian bytes (LP64!) — matches frozen isaac64.js contract |

Division: int → `(a / b) | 0`; unsigned → cmachine.u32div; `%` native.
Multiplication: Math.imul for 32-bit. Shifts: `<< >> >>>` native.

## Memory model (v0 → v1)

- v0 (rnd.c scope): structs → JS objects (fields as properties);
  arrays → JS arrays / typed wrappers; function pointers → JS function
  references (compare with ===, as whichrng does).
- v1 (full NetHack): hybrid — JS objects for structs + a typed-array
  heap region only where true address arithmetic occurs (`&field`,
  pointer casts, array decay into arithmetic). Decided per-declaration
  via AST analysis. Strings: C `char*` strings → Uint8Array + libc
  string functions operating on bytes (NOT JS strings; signedness and
  mutation semantics differ).

## Frozen-module bindings

Calls into `isaac64_*` bind to the frozen `js/isaac64.js` (the judge
overlays it; it is canonical). We do not ship a transpiled isaac64.
RNG logging follows the contest format (`rn2(N)=M`), produced by a
thin hand-written `rng.js` shim the transpiled rnd.c calls through —
matching how the C recorder's patches log.

## Emission conventions

- 1 C file → 1 JS file (`rnd.c` → `js/rnd.c.js`? no: `js/rnd.js`),
  same function names, statement order preserved.
- Every function gets JSDoc with C types mapped to typedefs:
  `/** C ref: rnd.c:75 — 0 <= rn2(x) < x. @param {CInt} x @returns {CInt} */`
- Every emitted expression that differs from JS semantics carries the
  coercion inline (`| 0`, `Math.imul`) — never hidden in helpers when
  an inline idiom is exact.
- No C-preprocessor remnants: AST is post-expansion; provenance
  comments name the macro when readability suffers (SIZE → note).

## Hard-construct gates (each: C fixture + transpiled twin + test)

1. Struct/union/pointer model (TValue union in Lua is the final exam)
2. setjmp/longjmp → exception-based nonlocal exit (also the async
   input boundary solution)
3. varargs (lua_pushvfstring, luaL_openlibs varargs)
4. Function pointers (opcode tables, lua_CFunction registry, window
   proc tables in wintty)

## Validation ladder (in order)

1. rnd.c → RNG-log parity vs recorded sessions (rng-diff.mjs)
2. hacklib.c → unit parity (string/bit functions)
3. Lua interpreter → differential harness (C-Lua vs JS-Lua on stock
   scripts + themerooms.lua with stub nh.*)
4. Subsystem merges → oracle (state dumps) green at every step
5. Full port → 44/44 public + sessions-extra corpus
