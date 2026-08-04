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

## Memory model (decided 2026-08-03; supersedes "v0 → v1")

Three tiers, chosen per-declaration by syntactic escape analysis
("does `&` appear on this decl / does it escape"), cheapest first
(credit: tiering rule from an external review of this project):

1. **Never address-taken** → plain JS local (`int i` → `let i`).
   Struct locals whose address never escapes → plain JS object.
2. **Address-taken scalar** → one-element box (`Int32Array([5])`, uses
   become `x[0]`).
3. **Address-taken aggregate / heap / strings** → CPtr: immutable
   `{ buf: Uint8Array, off }` (js/cptr.js). Alternative considered
   and rejected for now: TypedArray-view-as-pointer (`subarray` as
   p+n) — prettier `p[i]` syntax but one allocation per pointer op,
   element/byte offset duality, and unaligned typed-view throws.
   Revisit only if cptr emission proves unreadable at scale.

Landmarks: rnd.c + hacklib.c transpiled on this model; hacklib
differential parity 870/870 vs the recorder's hacklib.o.

## Watch items (from review + census)

- Uninitialized reads (MSan impractical on arm64 macOS) — suspect #1
  if a divergence ever resists the oracle.
- Struct padding bytes if any code memcmps/hashes whole structs.
- Lua `LUA_NUMBER_FMT` = "%.14g": if a script ever prints a float to a
  scored screen, hand-rolled %g rounding must match musl/macOS libc
  exactly; escape hatch is transpiling musl's printf.
- Function-pointer calls with mismatched arity silently produce
  undefined (not a crash) in JS — emit an arity check in debug builds.
- Recorder hygiene for NEW self-recordings: build a UBSan variant
  (-fsanitize=undefined,integer) + -fwrapv -fno-strict-aliasing, so
  differential trust never rests on UB. (-fwrapv semantics ≡ JS |0.)

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

## Swarm policy (DeepSeek v4-flash via opencode)

- Model: `deepseek-v4-flash`. `max_tokens` unset (provider default).
- reasoning_effort: `low` for bulk mechanical tasks, default (`high`)
  otherwise, `max` for gnarly debugging.
- **Circuit breaker: if one task burns >5,000,000 cumulative tokens
  (prompt+completion, tracked from API `usage`), stop that task and
  notify Noah WITH SOUND (`afplay /System/Library/Sounds/Glass.aiff`)
  to escalate to a smarter model (Qwen 3.8 / Kimi K3 class).** A task
  that expensive is stuck, not working — cheap models grind; the
  harness judges; humans break deadlocks.
- Swarm output is never self-certified: everything lands through the
  oracle / rng-diff / scorer gates.
