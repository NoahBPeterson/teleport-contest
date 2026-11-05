/* libc_real_ref.c — C oracle for the libc the game actually runs: g.* in
 * js/boot/harness.mjs and cptr.* (not js/libc/, which nothing imports).
 *
 * Prints one JSON object per case; test/libc-real.test.mjs replays them.
 * The sscanf formats are the ones in NetHack's own sources.
 *
 * Inputs are deliberately hostile. A case whose C behavior is undefined is
 * left out, so everything here must match byte for byte.
 */
#define _FORTIFY_SOURCE 0
#include <ctype.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static void jstr(const char *s, size_t n)
{
    size_t i;

    putchar('"');
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char) s[i];
        if (c == '"' || c == '\\') printf("\\%c", c);
        else if (c < 0x20 || c >= 0x7f) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}
static void js(const char *s) { jstr(s, strlen(s)); }
static void jhex(const void *p, size_t n)
{
    size_t i;

    putchar('"');
    for (i = 0; i < n; i++) printf("%02x", ((const unsigned char *) p)[i]);
    putchar('"');
}

/* ---- sscanf ------------------------------------------------------------ */
/* sig: one letter per pointer argument. i/u int, l long, c char[8], s char[300] */
static const struct { const char *fmt, *sig; } scans[] = {
    { "#%02x%02x%02x%c", "uuuc" },              /* coloratt.c */
    { "%ld", "l" },                             /* minion.c */
    { "%d,%ld,%lx;%d,%ld,%lx;0,0,%lx\n", "illilll" }, /* rumors.c */
    { "%5d\n", "i" },                           /* rumors.c */
    { "%5lx\n", "l" },                          /* rumors.c */
    { "%10s \"%255[^\"]\"", "ss" },             /* options.c */
    { "\"<%253[^\"]\" %c", "sc" },              /* options.c */
    { "\">%253[^\"]\" %c", "sc" },              /* options.c */
    { "\"%253[^\"]\" %c", "sc" },               /* options.c */
    { "%d%c", "ic" },                           /* wizcmds.c */
    { "%c%c %s %s%*c", "ccss" },                /* topten.c */
    { "%s %s %s %s %s %s%*c", "ssssss" },       /* topten.c */
    { "%c%c %[^,],%[^\n]%*c", "ccss" },         /* topten.c */
    { "%s %s %s %s %[^,],%[^\n]%*c", "ssssss" },/* topten.c */
    { "%u:%c", "uc" },                          /* end.c */
    { "%d%63s", "is" },                         /* files.c */
    { "MESG \"%255[^\"]\"%*[\t ]\"%255[^\"]\" %d %d", "ssii" }, /* sounds.c */
    { "MESG %10[^\"] \"%255[^\"]\"%*[\t ]\"%255[^\"]\" %d %d", "sssii" },
    { "MESG %10[^\"] \"%255[^\"]\"%*[\t ]\"%255[^\"]\" %d", "sssi" },
    { "MESG \"%255[^\"]\"%*[\t ]\"%255[^\"]\" %d", "ssi" },
    { "%8lx\n", "l" },                          /* pager.c */
    { "%ld,%d\n", "li" },                       /* pager.c */
    { "%ld %ld %ld %ld %ld\n", "lllll" },       /* dlb.c (fscanf) */
    { "%c%s %ld\n", "csl" },                    /* dlb.c (fscanf) */
    { "%d %d %d %ld %d %d %d %d %d %d %ld %ld %d%*c", "iiiliiiiiilli" }, /* topten.c (fscanf) */
    /* not in NetHack today; the engine should still be right */
    { "%i %i", "ii" }, { "%d%n", "ii" }, { "%o", "u" }, { "%X", "u" }, { "%x", "u" }, { "%hd", "i" },
    { "%hhd", "i" }, { "%c", "c" }, { "%3c", "c" }, { "%s", "s" }, { "%3s", "s" }, { "%*d %d", "i" },
    { "%%%d", "i" }, { "a %d", "i" }, { "%d b", "i" }, { " %d", "i" }, { "%[abc]", "s" },
    { "%[^abc]", "s" }, { "%2[abc]", "s" }, { "%[]a]", "s" }, { "%[a-c]", "s" }, { "%2d%2d", "ii" },
};
static const char *const scan_inputs[] = {
    "", " ", "\n", "abc", "12", "-5", "+7", "0", "007", "0x1f", "ff", "FF", "12x", "1 2",
    "2147483647", "2147483648", "-2147483648", "-2147483649", "4294967295", "99999999999", "99999999999999999999", "-99999999999999999999",
    "9223372036854775807", "123456", "1234567", "-1234", "abcdef", "abcdefgh", "abcdefghi",
    "#ff00aa", "#FF00AA", "#ff00aaz", "#ff00", "#f", "#ggg", "#0x1", "#ff 00 aa", "#",
    "\"foo\" x", "\"foo\"", "\"\"", "\"<foo\" x", "\">foo\" x", "\"<foo\"  ", "\"foo", "\"a b c\" y",
    "show \"a b\"", "hide \"", "stop", "averyveryverylongword \"x\"", "x \"y\" z",
    "5:x", "5:", ":x", "5 x", "-1:x",
    "12name", "12", "12 name", "x12",
    "1,2,a;3,4,b;0,0,c\n", "1,2,a;3,4,b;0,0,c", "1,2,a;3,4,b;0,1,c\n", "1,2,g;3,4,b;0,0,c\n",
    "00012\n", "12345\n", "123456\n", "abcde\n", "abcdef\n", "0x12\n", "0x\n", "0x", "0xg", "x1",
    "12345678\n", "123456789\n", "1,2\n", "1,\n", ",2\n",
    "1 2 3 4 5\n", "1 2 3 4\n", "afoo 12\n", "a 12\n", "afoo\n",
    "VaF foo bar\n", "Va foo,killed by a newt\n", "Va name,\n", "Val Hum Fem Law Bob killed,x\n",
    "Val Hum Fem Law Bob,killed by x\n", "a b c d e f\n", "a b c d e", "a,b",
    "1 2 3 4 5 6 7 8 9 10 11 12 13 \n", "1 2 3 4 5 6 7 8 9 10 11 12 13",
    "MESG \"a\" \"b\" 1 2", "MESG \"a\"\t \"b\" 1", "MESG hide \"a\" \"b\" 1 2", "MESG hide \"a\" \"b\" 3",
    "MESG \"a\"\"b\" 1", "MESG", "  12", "\t12", "\n12", "12\n", "\xc3\xa9", "\xff", "%", "%d",
};

/* ---- string and ctype functions ---------------------------------------- */
static const char *const strs[] = {
    "", "a", "A", "b", "abc", "ABC", "abd", "ab", "abcd", "aBc", " abc", "abc ", "a b",
    "\xff", "\x80", "a\xff", "\xe9", "z", "Z", "_", "[", "`", "{", "@", "0", "9",
};
static const int ccodes[] = {
    0, 1, 9, 10, 11, 12, 13, 31, 32, 33, 47, 48, 57, 58, 64, 65, 90, 91, 96, 97, 122, 123, 126, 127,
};

static void scan_case(const char *fmt, const char *sig, const char *in)
{
    union { int i; long l; char c[8]; char s[300]; } a[13];
    int n, k, nsig = (int) strlen(sig);

    memset(a, 0xAA, sizeof a);
    n = sscanf(in, fmt, &a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7], &a[8], &a[9],
               &a[10], &a[11], &a[12]);
    printf("{\"t\":\"sscanf\",\"fmt\":"); js(fmt);
    printf(",\"in\":"); js(in);
    printf(",\"sig\":"); js(sig);
    printf(",\"ret\":%d,\"out\":[", n);
    for (k = 0; k < nsig; k++) {
        size_t sz = sig[k] == 's' ? 300 : sig[k] == 'c' ? 8 : sig[k] == 'l' ? 8 : 4;
        if (k) putchar(',');
        jhex(&a[k], sz);
    }
    printf("]}\n");
}
static void rint_case(const char *fn, const char *a, const char *b, int r)
{
    printf("{\"t\":\"%s\",\"a\":", fn); js(a);
    if (b) { printf(",\"b\":"); js(b); }
    printf(",\"ret\":%d}\n", r);
}
#define SGN(x) ((x) < 0 ? -1 : (x) > 0 ? 1 : 0)

/* ---- printf: every conversion shape NetHack's format strings use ------- */
#define PF(fmtstr, tag, argstr, ...) do { char b_[512]; \
    snprintf(b_, sizeof b_, fmtstr, __VA_ARGS__); \
    printf("{\"t\":\"printf\",\"fmt\":"); js(fmtstr); \
    printf(",\"tags\":\"%s\",\"args\":[%s],\"want\":", tag, argstr); js(b_); printf("}\n"); } while (0)
static void printfs(void)
{
    static const int ds[] = { 0, 1, -1, 7, 42, -42, 999, 12345, 2147483647, -2147483647 - 1 };
    static const long ls[] = { 0, 1, -1, 42, -42, 10000000000L, -10000000000L, 9223372036854775807L, -9223372036854775807L - 1 };
    static const unsigned long uls[] = { 0, 1, 255, 4294967295UL, 4294967296UL, 18446744073709551615UL };
    static const char *const ss[] = { "", "a", "abc", "abcdefgh", "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789", "\xe9t\xe9", "a%db" };
    static const double fs[] = { 0, 100, 33.333, -1.5, 2.675, 0.005, 0.125, 0.375, 99.995, 1000000, 0.1 };
    size_t i; char a[1200];
#define EACH(arr) for (i = 0; i < sizeof arr / sizeof *arr; i++)
    EACH(ds) {
        sprintf(a, "%d", ds[i]);
#define D(f) PF(f, "d", a, ds[i])
        D("%d"); D("%i"); D("%5d"); D("%-5d"); D("%05d"); D("%+d"); D("%-1d"); D("%-d"); D("%2d"); D("%3d"); D("%4d"); D("%4i");
#undef D
#define U(f) PF(f, "d", a, (unsigned) ds[i])
        U("%u"); U("%3u"); U("%03u"); U("%x"); U("%X"); U("%02x"); U("%02X"); U("%08x"); U("%o"); U("%03o");
#undef U
        { char w[64]; sprintf(w, "6,%d", ds[i]); PF("%*d", "wd", w, 6, ds[i]); sprintf(w, "-6,%d", ds[i]); PF("%*d", "wd", w, -6, ds[i]); }
        if (ds[i] >= 32 && ds[i] < 127) { PF("%c", "c", a, ds[i]); PF("%3c", "c", a, ds[i]); PF("%-3c", "c", a, ds[i]); }
    }
    EACH(ls) {
        sprintf(a, "\"%ld\"", ls[i]);
#define L(f) PF(f, "l", a, ls[i])
        L("%ld"); L("%li"); L("%5ld"); L("%-2ld"); L("%08ld"); L("%lx"); L("%08lx");
#undef L
        PF("%lld", "l", a, (long long) ls[i]);
        { char w[64]; sprintf(w, "8,\"%ld\"", ls[i]); PF("%*ld", "wl", w, 8, ls[i]); }
    }
    EACH(uls) {
        sprintf(a, "\"%lu\"", uls[i]);
        PF("%lu", "l", a, uls[i]); PF("%02lu", "l", a, uls[i]); PF("%lx", "l", a, uls[i]); PF("%zu", "l", a, (size_t) uls[i]);
    }
    EACH(ss) {
        char q[1024]; size_t k, n = 0;
        q[n++] = '"';
        for (k = 0; ss[i][k]; k++) n += sprintf(q + n, "\\u%04x", (unsigned char) ss[i][k]);
        q[n++] = '"'; q[n] = 0;
#define S(f) PF(f, "s", q, ss[i])
        S("%s"); S("%.60s"); S("%5s"); S("%-5s"); S("%8.8s"); S("%-30.30s"); S("%.2s"); S("%.0s");
#undef S
        sprintf(a, "2,%s", q); PF("%.*s", "ws", a, 2, ss[i]); PF("%*s", "ws", a, 2, ss[i]);
        sprintf(a, "9,%s", q); PF("%-*s", "ws", a, 9, ss[i]); PF("%*s", "ws", a, 9, ss[i]);
        sprintf(a, "-1,%s", q); PF("%.*s", "ws", a, -1, ss[i]);
        sprintf(a, "45,%s", q); PF("%-45.*s", "ws", a, 45, ss[i]);
    }
    EACH(fs) {
        sprintf(a, "%.17g", fs[i]);
        PF("%6.2f", "f", a, fs[i]); PF("%f", "f", a, fs[i]); PF("%.0f", "f", a, fs[i]); PF("%.3f", "f", a, fs[i]);
    }
    PF("%%%d%%", "d", "5", 5);
    /* formats the port did not support at all until this test */
    PF("% d", "d", "5", 5); PF("% d", "d", "-5", -5); PF("%#x", "d", "255", 255); PF("%#X", "d", "255", 255);
    PF("%#o", "d", "8", 8); PF("%#x", "d", "0", 0); PF("%hd", "d", "70000", (short) 70000); PF("%hhd", "d", "300", (signed char) 300);
    PF("%hu", "d", "70000", (unsigned short) 70000); PF("%hhu", "d", "300", (unsigned char) 300); PF("%hx", "d", "70000", (unsigned short) 70000);
    PF("%td", "l", "\"-3\"", (ptrdiff_t) -3); PF("%5.3d", "d", "7", 7); PF("%05.3d", "d", "7", 7); PF("%.0d", "d", "0", 0); PF("%+05d", "d", "7", 7); PF("%-+5d|", "d", "7", 7);
    EACH(fs) {
        sprintf(a, "%.17g", fs[i]);
#define G(f) PF(f, "f", a, fs[i])
        G("%g"); G("%e"); G("%E"); G("%G"); G("%.3g"); G("%.3e"); G("%10.2e"); G("%-10.2g|"); G("%+g"); G("% g"); G("%#g"); G("%.0g"); G("%010.3f");
#undef G
    }
    PF("%g", "f", "1e+21", 1e21); PF("%g", "f", "1.5e-07", 1.5e-7); PF("%g", "f", "100000", 100000.0); PF("%g", "f", "1000000", 1000000.0); PF("%e", "f", "0", 0.0); PF("%.17g", "f", "0.1", 0.1);
    PF("0%03o or 0x%02x", "dd", "8,8", 8, 8);
    PF("%s:%-2ld", "sl", "\"ab\",\"7\"", "ab", 7L);
    PF("%4d / %4d (%6.2f%%): %s", "ddfs", "1,2,50.0,\"x\"", 1, 2, 50.0, "x");
}

int main(void)
{
    size_t i, j;
    int c, n;

    for (i = 0; i < sizeof scans / sizeof *scans; i++)
        for (j = 0; j < sizeof scan_inputs / sizeof *scan_inputs; j++)
            scan_case(scans[i].fmt, scans[i].sig, scan_inputs[j]);

    for (i = 0; i < sizeof strs / sizeof *strs; i++) {
        for (j = 0; j < sizeof strs / sizeof *strs; j++) {
            rint_case("strcmp", strs[i], strs[j], SGN(strcmp(strs[i], strs[j])));
            rint_case("strcasecmp", strs[i], strs[j], SGN(strcasecmp(strs[i], strs[j])));
            rint_case("strspn", strs[i], strs[j], (int) strspn(strs[i], strs[j]));
            rint_case("strcspn", strs[i], strs[j], (int) strcspn(strs[i], strs[j]));
            { const char *p = strpbrk(strs[i], strs[j]);
              rint_case("strpbrk", strs[i], strs[j], p ? (int) (p - strs[i]) : -1); }
            { const char *p = strstr(strs[i], strs[j]);
              rint_case("strstr", strs[i], strs[j], p ? (int) (p - strs[i]) : -1); }
            for (n = 0; n < 4; n++) {
                printf("{\"t\":\"strncmp\",\"n\":%d,\"a\":", n); js(strs[i]);
                printf(",\"b\":"); js(strs[j]);
                printf(",\"ret\":%d}\n", SGN(strncmp(strs[i], strs[j], n)));
                printf("{\"t\":\"strncasecmp\",\"n\":%d,\"a\":", n); js(strs[i]);
                printf(",\"b\":"); js(strs[j]);
                printf(",\"ret\":%d}\n", SGN(strncasecmp(strs[i], strs[j], n)));
            }
        }
        rint_case("strlen", strs[i], NULL, (int) strlen(strs[i]));
        for (j = 0; j < sizeof ccodes / sizeof *ccodes; j++) {
            const char *p = strchr(strs[i], ccodes[j]), *q = strrchr(strs[i], ccodes[j]);
            printf("{\"t\":\"strchr\",\"a\":"); js(strs[i]);
            printf(",\"c\":%d,\"ret\":%d,\"ret2\":%d}\n", ccodes[j],
                   p ? (int) (p - strs[i]) : -1, q ? (int) (q - strs[i]) : -1);
        }
    }
    {
        static const char *const nums[] = {
            "", " ", "0", "12", "-5", "+7", "  42", "\t42", "\n42", "12x", "x", "0x10", "010", "1e3",
            "2147483647", "2147483648", "-2147483648", "-2147483649", "4294967296", "- 5", "+-5", "9999999999",
        };
        for (i = 0; i < sizeof nums / sizeof *nums; i++) {
            char *e;
            long v;
            static const int bases[] = { 10, 0, 16, 8 };
            printf("{\"t\":\"atoi\",\"a\":"); js(nums[i]); printf(",\"ret\":%d,\"retl\":\"%ld\"}\n", atoi(nums[i]), atol(nums[i]));
            for (j = 0; j < 4; j++) {
                v = strtol(nums[i], &e, bases[j]);
                printf("{\"t\":\"strtol\",\"a\":"); js(nums[i]);
                printf(",\"base\":%d,\"ret\":\"%ld\",\"end\":%d}\n", bases[j], v, (int) (e - nums[i]));
                printf("{\"t\":\"strtoul\",\"a\":"); js(nums[i]);
                printf(",\"base\":%d,\"ret\":\"%lu\",\"end\":%d}\n", bases[j], strtoul(nums[i], &e, bases[j]), (int) (e - nums[i]));
            }
        }
    }
    for (c = 0; c < 256; c++)
        printf("{\"t\":\"ctype\",\"c\":%d,\"r\":[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]}\n", c,
               !!isalnum(c), !!isalpha(c), !!iscntrl(c), !!isdigit(c), !!islower(c),
               !!isprint(c), !!ispunct(c), !!isspace(c), !!isupper(c), toupper(c) * 1000 + tolower(c));
    printfs();
    return 0;
}
