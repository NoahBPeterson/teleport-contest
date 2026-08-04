// cmachine.test.mjs — edge-case validation of C scalar semantics.
// Run: node test/cmachine.test.mjs

import {
    i32, u32, schar, uchar, i16, u16, imul,
    i32div, u32div, u32mod, i64, u64, i64div, fround,
} from '../js/cmachine.js';

let failures = 0;
function eq(name, got, want) {
    // eslint-disable-next-line eqeqeq
    if (got !== want) {
        console.error(`FAIL ${name}: got ${got}, want ${want}`);
        failures++;
    }
}

// 32-bit wraparound
eq('i32 wrap high', i32(2 ** 31), -(2 ** 31));
eq('i32 wrap low', i32(-(2 ** 31) - 1), 2 ** 31 - 1);
eq('u32 wrap', u32(-1), 4294967295);
eq('u32 of 2^32', u32(2 ** 32), 0);

// narrow types
eq('schar 127', schar(127), 127);
eq('schar 128', schar(128), -128);
eq('schar 255', schar(255), -1);
eq('uchar 255', uchar(255), 255);
eq('uchar 256', uchar(256), 0);
eq('i16 32768', i16(32768), -32768);
eq('u16 65536', u16(65536), 0);

// multiplication: the case where `a*b|0` is wrong but imul is right
eq('imul 2^30 * 4', imul(2 ** 30, 4), 0);            // 2^32 wraps to 0
eq('imul big', imul(0x7FFFFFFF, 0x7FFFFFFF), 1);      // (2^31-1)^2 mod 2^32
eq('imul neg', imul(-7, 6), -42);

// signed division truncates toward zero (not floor)
eq('i32div 7/2', i32div(7, 2), 3);
eq('i32div -7/2', i32div(-7, 2), -3);                 // floor would give -4
eq('i32div 7/-2', i32div(7, -2), -3);
eq('i32div -7/-2', i32div(-7, -2), 3);
eq('i32div INT_MIN/1', i32div(-(2 ** 31), 1), -(2 ** 31));

// C remainder keeps dividend sign (JS % matches natively)
eq('mod -7%3', -7 % 3, -1);

// unsigned division/modulo
eq('u32div 2^32-1 / 3', u32div(4294967295, 3), 1431655765);
eq('u32div by 1', u32div(4294967295, 1), 4294967295);
eq('u32div small', u32div(7, 2), 3);
eq('u32mod exact factor', u32mod(4294967295, 65537), 0); // 2^32-1 = 3*5*17*257*65537
eq('u32mod with remainder', u32mod(4294967295, 7), 3);

// 64-bit via BigInt
eq('i64 wrap', i64(2n ** 63n), -(2n ** 63n));
eq('u64 wrap', u64(-1n), 0xFFFFFFFFFFFFFFFFn);
eq('u64 mul wrap', u64(0xFFFFFFFFFFFFFFFFn * 2n), 0xFFFFFFFFFFFFFFFEn);
eq('i64div -7/2', i64div(-7n, 2n), -3n);
eq('u64 isaac add', u64(0xFFFFFFFFFFFFFFF5n + 0x20n), 0x15n);

// float rounding
eq('fround 0.1', fround(0.1), Math.fround(0.1));
eq('fround precision', fround(1.0000000001) === 1.0000000001, false);

if (failures) {
    console.error(`\n${failures} FAILURES`);
    process.exit(1);
}
console.log('cmachine.test.mjs: all OK');
