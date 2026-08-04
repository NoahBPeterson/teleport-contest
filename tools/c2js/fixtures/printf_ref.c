/* printf_ref.c — C reference oracle for the js/libc/printf.js shim.
 *
 * Prints one JSON object per case: {"fmt":…, "args":[…], "expected":…}
 * covering exactly the format-specifier inventory used by NetHack 5.0
 * C sources (see commit message / tools/swarm/packets/printf.md).
 *
 * Build:  clang -o printf_ref printf_ref.c
 * Run:    ./printf_ref > printf-cases.jsonl
 *
 * The JSON "args" carry the values AS THE JS SHIM WILL RECEIVE THEM
 * (post-coercion: %u of a negative int is passed as its u32 value,
 * %ld values as Numbers — our transpiler coerces at the cast site).
 */
#include <stdio.h>
#include <string.h>

static int caseno = 0;

/* emit one case: fmt + json-args + formatted result */
#define CASE(fmtstr, jsonargs, ...) do { \
    char buf[512]; \
    snprintf(buf, sizeof buf, fmtstr, ##__VA_ARGS__); \
    printf("{\"n\":%d,\"fmt\":%s,\"args\":[%s],\"expected\":", \
           caseno++, jsonstr(fmtstr), jsonargs); \
    jsonprint(buf); \
    printf("}\n"); \
} while (0)

static const char *jsonstr(const char *s) {
    /* returns s as a JSON string literal (static ring of buffers) */
    static char ring[4][1024];
    static int ri = 0;
    char *out = ring[ri = (ri + 1) & 3];
    char *p = out;
    *p++ = '"';
    for (; *s; s++) {
        unsigned char c = (unsigned char) *s;
        if (c == '"' || c == '\\') { *p++ = '\\'; *p++ = (char) c; }
        else if (c == '\n') { *p++ = '\\'; *p++ = 'n'; }
        else if (c == '\t') { *p++ = '\\'; *p++ = 't'; }
        else if (c < 32) { p += sprintf(p, "\\u%04x", c); }
        else *p++ = (char) c;
    }
    *p++ = '"'; *p = 0;
    return out;
}

static void jsonprint(const char *s) {
    fputs(jsonstr(s), stdout);
}

int
main(void)
{
    /* %% and plain text */
    CASE("100%%", "");
    CASE("hello world", "");
    CASE("", "");
    /* %d family */
    CASE("%d", "0", 0);
    CASE("%d", "-1", -1);
    CASE("%d", "2147483647", 2147483647);
    CASE("%d", "-2147483648", (-2147483647 - 1));
    CASE("%2d", "5", 5);
    CASE("%2d", "123", 123);
    CASE("%4d", "-42", -42);
    CASE("%-4d.", "7", 7);
    CASE("%02d", "3", 3);
    CASE("%02d", "-3", -3);
    CASE("%05d", "-42", -42);
    CASE("%+d", "5", 5);
    CASE("% d", "5", 5);
    CASE("% d", "-5", -5);
    /* %i behaves like %d */
    CASE("%i", "-17", -17);
    /* %u — args pre-coerced to u32 by our emitter */
    CASE("%u", "0", 0u);
    CASE("%u", "4294967295", 4294967295u);
    CASE("%5u", "12", 12u);
    /* %x / %X / %03x / %02x / %08lx */
    CASE("%x", "255", 255u);
    CASE("%x", "3735928559", 3735928559u);
    CASE("%03x", "26", 26u);
    CASE("%02x", "10", 10u);
    CASE("%08lx", "305419896", 305419896L);
    CASE("%lx", "-1", -1L);
    /* %ld / %lu / %06ld / %08ld */
    CASE("%ld", "0", 0L);
    CASE("%ld", "-123456789", -123456789L);
    CASE("%lu", "4294967295", 4294967295UL);
    CASE("%06ld", "42", 42L);
    CASE("%08ld", "-42", -42L);
    /* %c and "% c" */
    CASE("%c", "64", '@');
    CASE("%c", "97", 'a');
    CASE("% c", "65", 'A');
    CASE("% c", "32", ' ');
    /* %s with width/precision */
    CASE("%s", "\"\"", "");
    CASE("%s", "\"hello\"", "hello");
    CASE("%12s", "\"abc\"", "abc");
    CASE("%-12s|", "\"abc\"", "abc");
    CASE("%.20s", "\"abcdefghijklmnopqrstuvwxyz0123456789\"", "abcdefghijklmnopqrstuvwxyz0123456789");
    CASE("%.3s", "\"abcdef\"", "abcdef");
    CASE("%2.2s", "\"abcd\"", "abcd");
    CASE("%.60s", "\"short\"", "short");
    CASE("%.0s|", "\"abc\"", "abc");
    CASE("%-8.3s|", "\"abcdef\"", "abcdef");
    /* mixed */
    CASE("%s:%d", "\"x\",3", "x", 3);
    CASE("%d%% of %s", "75,\"cake\"", 75, "cake");
    CASE("%c%d%c", "97,5,98", 'a', 5, 'b');
    /* width via negative/large content overflow */
    CASE("%3s", "\"toolong\"", "toolong");
    CASE("%-3d|", "12345", 12345);
    /* %p — implementation-defined; our shim prints 0x… hex of a number.
       The recorder's screens never expose raw addresses on scored paths
       (verified: %p appears only in debug/panic output), so pin %p to
       glibc-style 0x + lowercase hex of the pointer VALUE we hand it. */
    CASE("%p", "\"0x0\"", (void *) 0);
    CASE("%p", "\"0xdeadbeef\"", (void *) 0xdeadbeef);
    return 0;
}
