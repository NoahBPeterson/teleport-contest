// cmachine.js — C scalar semantics for the transpiled runtime.
//
// Every arithmetic emission from the clang-AST transpiler routes
// through these helpers (or the documented inline idioms below) so
// that the JS port reproduces the C recorder's LP64/clang semantics
// exactly: 32-bit `int` with two's-complement wraparound, 8/16-bit
// char/short, 64-bit `long long` via BigInt, IEEE-754 float/double.
//
// Conventions used by emitted code:
//   C int add/sub/mul        (a + b) | 0        Math.imul(a, b)
//   C unsigned int           (a + b) >>> 0      (u32 helpers below)
//   C int division           i32div(a, b)  (truncation toward zero)
//   C int remainder          a % b         (JS % already truncates)
//   C bitwise on int         & | ^ << >>   (JS bitwise is 32-bit two's
//                                           complement — exact match)
//   C unsigned shift         >>>
//   C long long / uint64     BigInt + u64()/i64() wrappers
//   C float                  fround() at every store
//
// Division by zero traps in C and yields Infinity/NaN in JS; NetHack
// never divides by zero on valid paths, so emitted code does not
// guard. If a divergence ever localizes to a division, check here.

/** C `int` (32-bit two's complement). @typedef {number} CInt */
/** C `unsigned int`. @typedef {number} CUInt */
/** C `long long` — always a JS BigInt. @typedef {bigint} CLongLong */
/** C `double` — identical to JS number. @typedef {number} CDouble */
/** C `float` — JS number rounded via Math.fround at stores. @typedef {number} CFloat */

/**
 * Truncate to C `int` range with wraparound.
 * @param {number} x
 * @returns {CInt}
 */
export function i32(x) { return x | 0; }

/**
 * Truncate to C `unsigned int` range.
 * @param {number} x
 * @returns {CUInt}
 */
export function u32(x) { return x >>> 0; }

/**
 * C `signed char` (this target: signed, 8-bit).
 * @param {number} x
 * @returns {CInt}
 */
export function schar(x) { return (x << 24) >> 24; }

/**
 * C `unsigned char`.
 * @param {number} x
 * @returns {CInt}
 */
export function uchar(x) { return x & 0xFF; }

/**
 * C `short` (16-bit two's complement).
 * @param {number} x
 * @returns {CInt}
 */
export function i16(x) { return (x << 16) >> 16; }

/**
 * C `unsigned short`.
 * @param {number} x
 * @returns {CInt}
 */
export function u16(x) { return x & 0xFFFF; }

/**
 * C `int * int` with 32-bit wraparound. Bare `a * b | 0` is WRONG for
 * large operands: the double product loses low bits beyond 2^53 before
 * truncation. Math.imul computes the true low 32 bits.
 * @param {CInt} a
 * @param {CInt} b
 * @returns {CInt}
 */
export function imul(a, b) { return Math.imul(a, b); }

/**
 * C `int / int` — truncation toward zero. Exact for all int32 operand
 * pairs (quotients fit in 31 bits, well inside double precision).
 * @param {CInt} a
 * @param {CInt} b
 * @returns {CInt}
 */
export function i32div(a, b) { return (a / b) | 0; }

/**
 * C `unsigned / unsigned` (32-bit). Computed via exact remainder
 * subtraction so double rounding can never round the quotient up.
 * @param {CUInt} a
 * @param {CUInt} b
 * @returns {CUInt}
 */
export function u32div(a, b) {
    a >>>= 0; b >>>= 0;
    return ((a - (a % b)) / b) >>> 0;
}

/**
 * C `unsigned % unsigned` (32-bit). Exact: operands < 2^32, and the
 * double remainder is exact below 2^53.
 * @param {CUInt} a
 * @param {CUInt} b
 * @returns {CUInt}
 */
export function u32mod(a, b) { return (a >>> 0) % (b >>> 0); }

/**
 * C `long long` wraparound (signed 64-bit). BigInt bitwise ops use
 * infinite two's complement, so `& MASK64` already wraps; these make
 * signedness explicit at the type boundary.
 * @param {bigint} x
 * @returns {CLongLong}
 */
export function i64(x) { return BigInt.asIntN(64, x); }

/**
 * C `unsigned long long` wraparound.
 * @param {bigint} x
 * @returns {CLongLong}
 */
export function u64(x) { return BigInt.asUintN(64, x); }

/**
 * C 64-bit integer division (truncation toward zero). BigInt `/`
 * already truncates toward zero — identical to C. This wrapper exists
 * so call sites read as C-typed operations, not JS accidents.
 * @param {CLongLong} a
 * @param {CLongLong} b
 * @returns {CLongLong}
 */
export function i64div(a, b) { return a / b; }

/**
 * C `float` store rounding. Doubles need no help (JS number IS IEEE
 * double); float does.
 * @param {number} x
 * @returns {CFloat}
 */
export function fround(x) { return Math.fround(x); }
