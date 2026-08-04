---
task: libc-printf
effort: low
---
Implement `js/libc/printf.js`: a C-printf-faithful `sprintf`/`snprintf` for a NetHack transpilation project, plus its test runner.

## What to build

File 1: `js/libc/printf.js` exporting:
- `sprintf(fmt, ...args)` → string
- `snprintf(buf, n, fmt, ...args)` → number (writes into a Uint8Array `buf`, NUL-terminated, at most n-1 chars; returns the would-be length, C semantics)
- `vsprintf`/`vsnprintf` are NOT needed.

Supported specifiers (the complete inventory NetHack 5.0 uses): `%d %i %u %ld %lu %lx %08lx %x %03x %02x %X %c `%c`(space-flag) %s %.Ns %Ns %-Ns %N.Ms %02d %05d %4d %-1d %06ld %08ld %p %%` — i.e. conversions `d i u x X c s p %`, flags `- + space # 0`, decimal width, `.precision`, length `l`.

Argument conventions (our transpiler pre-coerces, so the shim stays dumb):
- `%d %i %x %u %c` args arrive as JS numbers already coerced to C int/unsigned (`%u` never sees negatives — it gets 4294967295 for C -1; `%c` gets the char CODE number).
- `%ld %lu %lx` args arrive as JS numbers OR BigInts — support both (BigInt for 64-bit values).
- `%s` args arrive as JS strings.
- `%p` args arrive as strings already in "0x…" form — print them through, and print "0x0" for null/0.
- `%s` of null/undefined must print "(null)" (glibc/macOS behavior).

Semantics that must be exact (from C reference runs on macOS libc):
- Zero-padding is sign-aware: sprintf("%05d", -42) === "-0042"; sprintf("%08ld", -42) === "-0000042".
- The space flag is IGNORED for %c on this libc: sprintf("% c", 65) === "A".
- Precision truncates strings: sprintf("%.3s", "abcdef") === "abc"; width pads: "%-8.3s" of "abcdef" === "abc     ".
- "%.0s" of anything === "".
- %05d of 3 === "00003"; %2d of 123 === "123" (width never truncates).
- %x of 3735928559 === "deadbeef"; %X uppercase.
- %#x of 255 === "0xff"; %#o is not needed.
- Width may NOT come from `*` (NetHack doesn't use it) — you may skip `*`.

File 2: `test/printf.test.mjs` — a Node 22 test runner (plain node, no deps, exits nonzero on failure) that reads the JSONL case file at `tools/c2js/fixtures/printf-cases.jsonl` (each line {"n","fmt","args","expected"}) and asserts sprintf(fmt, ...args) === expected for every case, printing a summary. It must run from the repo root: `node test/printf.test.mjs`.

The case file already exists with 53 cases; here are several verbatim so you know the shape (do not re-derive these values — they are ground truth from C):

{"n":0,"fmt":"100%%","args":[],"expected":"100%"}
{"n":1,"fmt":"hello world","args":[],"expected":"hello world"}
{"n":2,"fmt":"","args":[],"expected":""}
{"n":3,"fmt":"%d","args":[0],"expected":"0"}
{"n":4,"fmt":"%d","args":[-1],"expected":"-1"}
{"n":5,"fmt":"%d","args":[2147483647],"expected":"2147483647"}
{"n":6,"fmt":"%d","args":[-2147483648],"expected":"-2147483648"}
{"n":7,"fmt":"%2d","args":[5],"expected":" 5"}
{"n":8,"fmt":"%2d","args":[123],"expected":"123"}
{"n":9,"fmt":"%4d","args":[-42],"expected":" -42"}
{"n":10,"fmt":"%-4d.","args":[7],"expected":"7   ."}
{"n":11,"fmt":"%02d","args":[3],"expected":"03"}
{"n":12,"fmt":"%02d","args":[-3],"expected":"-3"}
{"n":13,"fmt":"%05d","args":[-42],"expected":"-0042"}
{"n":14,"fmt":"%+d","args":[5],"expected":"+5"}
{"n":15,"fmt":"% d","args":[5],"expected":" 5"}
{"n":16,"fmt":"% d","args":[-5],"expected":"-5"}
{"n":17,"fmt":"%i","args":[-17],"expected":"-17"}
{"n":18,"fmt":"%u","args":[0],"expected":"0"}
{"n":19,"fmt":"%u","args":[4294967295],"expected":"4294967295"}

...and the remaining 33 lines in the file follow the same schema. Your test runner reads the file, so you don't need the rest inline — but your implementation must handle every case in it.

Hard requirements: plain ES6, no dependencies, no TypeScript syntax. JSDoc on every exported function. Remember the // file: first-line convention per the system prompt.
