/* hacklib_battery.c — differential battery driver for hacklib.c (C side).
 *
 * Prints a line-based transcript:
 *   # <fn> <case#>
 *   IN <hex-bytes|int> ...        (one per input arg; buffers are 512 bytes,
 *                                  zero-filled, with the decoded bytes at 0)
 *   RET int:<n> | RET null | RET str:<hex> | RET ptr:<buf#>:<off>:<hex>
 *   BUF<k> <hex>                  (post-call C-string content of buffer k)
 *   DATA <hex>                    (binary payload, e.g. copy_bytes dest)
 *
 * The JS harness (tools/c2js/test-hacklib.mjs) replays the IN lines through
 * js/generated/hacklib.js and diffs the RET/BUF/DATA lines.
 *
 * Build (from repo root):
 *   clang -I nethack-c/recorder/include -DNOTPARMDECL -DNO_TIMED_DELAY \
 *     tools/c2js/fixtures/hacklib_battery.c nethack-c/recorder/src/hacklib.o \
 *     -o .cache/c2js/build/hacklib_battery
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include "hack.h"

#define NBUF 3
#define BSZ 512
static char buf[NBUF][BSZ];

static void reset_bufs(void) { memset(buf, 0, sizeof buf); }

static void unhex(const char *h, char *out) {
    while (h[0] && h[1]) {
        unsigned v;
        sscanf(h, "%2x", &v);
        *out++ = (char) v;
        h += 2;
    }
    *out = 0;
}

static void phexstr(const char *p) {
    const unsigned char *u = (const unsigned char *) p;
    for (; *u; u++) printf("%02x", *u);
}

static void phexn(const unsigned char *u, long n) {
    long i;
    for (i = 0; i < n; i++) printf("%02x", u[i]);
}

/* print a returned char*: ptr form if inside a case buffer, else str form */
static void pret_ptr(const char *ret) {
    int i;
    if (!ret) { printf("RET null\n"); return; }
    for (i = 0; i < NBUF; i++) {
        if (ret >= buf[i] && ret < buf[i] + BSZ) {
            printf("RET ptr:%d:%ld:", i, (long) (ret - buf[i]));
            phexstr(ret);
            printf("\n");
            return;
        }
    }
    printf("RET str:");
    phexstr(ret);
    printf("\n");
}
static void pret_int(long v) { printf("RET int:%ld\n", v); }
static void pbuf(int k) { printf("BUF%d ", k); phexstr(buf[k]); printf("\n"); }

static void case_hdr(const char *fn, int idx) { printf("# %s %d\n", fn, idx); }

/* ---- batteries --------------------------------------------------------- */

static const char *STRS[] = {
    "", "a", "ABC def GHI", "  lead", "trail  ", "  a  b  c  ",
    "a\tb\tc", "tab\texpand\tme", "\tmixed \t ws\n", "with\nnewline",
    "with\r\ncrlf", "no newline", "\n", " ", "  ", "aBc DeF gHi",
    "MiXeD123!@#", "under_score-dash", "x\ty\t\tz  ",
    "1234567\tX", "12345678\tY", "   ", "one two  three\tfour\nfive",
    "a" "\x80" "\xC0" "z", "caf\xC3\xA9",
};
static const int NSTRS = (int) (sizeof STRS / sizeof STRS[0]);

static const int CHARS[] = {
    -128, -97, -96, -65, -64, -33, -32, -1, 0, 9, 10, 31, 32, 33,
    47, 48, 57, 58, 64, 65, 90, 91, 96, 97, 122, 123, 126, 127,
    -1000, 1000, 255, 256,
};
static const int NCHARS = (int) (sizeof CHARS / sizeof CHARS[0]);

static char *hexof(const char *s, char *out) { /* encode input for IN lines */
    const unsigned char *u = (const unsigned char *) s;
    out[0] = 0;
    for (; *u; u++) sprintf(out + strlen(out), "%02x", *u);
    return out;
}

#define CASE1(fn, s, i) do { \
    reset_bufs(); \
    strcpy(buf[0], (s)); \
    case_hdr(fn, i); \
    printf("IN %s\n", hex0); \
} while (0)

static char hex0[2048];

int
main(void)
{
    int i, j, k;

    /* char -> int/boolean/char functions */
    for (i = 0; i < NCHARS; i++) {
        int c = CHARS[i];
        case_hdr("digit", i); printf("IN %d\n", c); pret_int(digit((char) c));
        case_hdr("letter", i); printf("IN %d\n", c); pret_int(letter((char) c));
        case_hdr("highc", i); printf("IN %d\n", c); pret_int((unsigned char) highc((char) c));
        case_hdr("lowc", i); printf("IN %d\n", c); pret_int((unsigned char) lowc((char) c));
        case_hdr("visctrl", i); printf("IN %d\n", c); pret_ptr(visctrl((char) c));
    }
    for (i = 0; i < NCHARS; i += 5) {
        for (j = 0; j < NCHARS; j += 7) {
            case_hdr("chrcasecpy", i * 100 + j);
            printf("IN %d %d\n", CHARS[i], CHARS[j]);
            pret_int((unsigned char) chrcasecpy(CHARS[i], CHARS[j]));
        }
    }

    /* single-string in-place functions: RET ptr + BUF0 */
    for (i = 0; i < NSTRS; i++) {
        hexof(STRS[i], hex0);
        CASE1("lcase", STRS[i], i); pret_ptr(lcase(buf[0])); pbuf(0);
        CASE1("ucase", STRS[i], i); pret_ptr(ucase(buf[0])); pbuf(0);
        CASE1("upstart", STRS[i], i); pret_ptr(upstart(buf[0])); pbuf(0);
        CASE1("upwords", STRS[i], i); pret_ptr(upwords(buf[0])); pbuf(0);
        CASE1("mungspaces", STRS[i], i); pret_ptr(mungspaces(buf[0])); pbuf(0);
        CASE1("trimspaces", STRS[i], i); pret_ptr(trimspaces(buf[0])); pbuf(0);
        CASE1("strip_newline", STRS[i], i); pret_ptr(strip_newline(buf[0])); pbuf(0);
        CASE1("stripdigits", STRS[i], i); pret_ptr(stripdigits(buf[0])); pbuf(0);
        CASE1("tabexpand", STRS[i], i); pret_ptr(tabexpand(buf[0])); pbuf(0);
        CASE1("eos", STRS[i], i); pret_ptr(eos(buf[0]));
        CASE1("c_eos", STRS[i], i); pret_ptr(c_eos(buf[0]));
        CASE1("onlyspace", STRS[i], i); pret_int(onlyspace(buf[0]));
        CASE1("str_lines_maxlen", STRS[i], i); pret_int(str_lines_maxlen(buf[0]));
        CASE1("s_suffix", STRS[i], i); pret_ptr(s_suffix(buf[0]));
        CASE1("ing_suffix", STRS[i], i); pret_ptr(ing_suffix(buf[0]));
        CASE1("xcrypt", STRS[i], i); pret_ptr(xcrypt(buf[0], buf[1])); pbuf(1);
    }
    /* tabexpand truncation: 40 tabs -> 320 spaces > BUFSZ */
    {
        char longtabs[64];
        memset(longtabs, '\t', 40); longtabs[40] = 0;
        reset_bufs(); strcpy(buf[0], longtabs);
        case_hdr("tabexpand", 900); printf("IN %s\n", "0909090909090909090909090909090909090909090909090909090909090909090909090909090909");
        pret_ptr(tabexpand(buf[0])); pbuf(0);
        /* long string without tabs (300 'a') */
        reset_bufs(); memset(buf[0], 'a', 300); buf[0][300] = 0;
        case_hdr("tabexpand", 901); printf("IN %s\n", "LONGA300");
        pret_ptr(tabexpand(buf[0])); pbuf(0);
    }

    /* strkitten */
    {
        static const char *ks[] = { "", "a", "abc", "with space" };
        static const int kc[] = { '!', 'x', 'Z', 0x80 };
        for (i = 0; i < 4; i++) {
            reset_bufs(); strcpy(buf[0], ks[i]);
            case_hdr("strkitten", i); printf("IN %s %d\n", hexof(ks[i], hex0), kc[i]);
            pret_ptr(strkitten(buf[0], (char) kc[i])); pbuf(0);
        }
    }

    /* copynchars: src + n */
    {
        static const char *cs[] = { "", "a", "abc", "ab\ncd", "a long string here" };
        static const int cn[] = { 0, 1, 3, 5, 100 };
        for (i = 0; i < 5; i++) for (j = 0; j < 5; j++) {
            reset_bufs(); strcpy(buf[0], cs[i]);
            case_hdr("copynchars", i * 10 + j);
            printf("IN %s %d\n", hexof(cs[i], hex0), cn[j]);
            copynchars(buf[1], buf[0], cn[j]);
            pbuf(1);
        }
    }

    /* strcasecpy: dst + src */
    {
        static const char *cd[] = { "ABC", "abc", "aBc", "ab", "abcdef", "X" };
        static const char *cs[] = { "xy", "XYZW", "qWeRtY", "ABCDEFGH", "z", "" };
        for (i = 0; i < 6; i++) for (j = 0; j < 5; j++) {
            reset_bufs(); strcpy(buf[0], cd[i]); strcpy(buf[1], cs[j]);
            case_hdr("strcasecpy", i * 10 + j);
            printf("IN %s %s\n", hexof(cd[i], hex0), hexof(cs[j], hex0 + 1024));
            pret_ptr(strcasecpy(buf[0], buf[1])); pbuf(0);
        }
    }

    /* str_start_is / str_end_is */
    {
        static const char *pa[][2] = {
            { "hello", "he" }, { "hello", "hello" }, { "hello", "hello!" },
            { "", "x" }, { "", "" }, { "ABC", "ab" }, { "ABC", "AB" },
            { "abc", "ABD" }, { "abc", "abC" },
        };
        for (i = 0; i < 9; i++) for (j = 0; j < 2; j++) {
            reset_bufs(); strcpy(buf[0], pa[i][0]); strcpy(buf[1], pa[i][1]);
            case_hdr("str_start_is", i * 10 + j);
            printf("IN %s ", hexof(pa[i][0], hex0));
            printf("%s %d\n", hexof(pa[i][1], hex0 + 1024), j);
            pret_int(str_start_is(buf[0], buf[1], j));
        }
        static const char *pe[][2] = {
            { "hello", "llo" }, { "hello", "x" }, { "hello", "hello" },
            { "hi", "hello" }, { "", "" }, { "abc", "" }, { "", "x" },
        };
        for (i = 0; i < 7; i++) {
            reset_bufs(); strcpy(buf[0], pe[i][0]); strcpy(buf[1], pe[i][1]);
            case_hdr("str_end_is", i);
            printf("IN %s ", hexof(pe[i][0], hex0));
            printf("%s\n", hexof(pe[i][1], hex0 + 1024));
            pret_int(str_end_is(buf[0], buf[1]));
        }
    }

    /* strncmpi */
    {
        static const char *pn[][2] = {
            { "abc", "ABC" }, { "abc", "ABD" }, { "ab", "abc" },
            { "abc", "ab" }, { "", "" }, { "Zebra", "zebra" },
        };
        static const int pnn[] = { 1, 3, 100, -1 };
        for (i = 0; i < 6; i++) for (j = 0; j < 4; j++) {
            reset_bufs(); strcpy(buf[0], pn[i][0]); strcpy(buf[1], pn[i][1]);
            case_hdr("strncmpi", i * 10 + j);
            printf("IN %s ", hexof(pn[i][0], hex0));
            printf("%s %d\n", hexof(pn[i][1], hex0 + 1024), pnn[j]);
            pret_int(strncmpi(buf[0], buf[1], pnn[j]));
        }
    }

    /* strstri */
    {
        static const char *ps[][2] = {
            { "Hello World", "world" }, { "Hello", "WORLD" }, { "abc", "abcd" },
            { "aaa", "aa" }, { "x", "" }, { "", "x" }, { "aAbB", "ab" },
            { "short", "a much longer substring" },
        };
        for (i = 0; i < 8; i++) {
            reset_bufs(); strcpy(buf[0], ps[i][0]); strcpy(buf[1], ps[i][1]);
            case_hdr("strstri", i);
            printf("IN %s ", hexof(ps[i][0], hex0));
            printf("%s\n", hexof(ps[i][1], hex0 + 1024));
            pret_ptr(strstri(buf[0], buf[1]));
        }
    }

    /* fuzzymatch */
    {
        static const char *pf[][3] = {
            { "a b c", "abc", " " }, { "AbC", "abc", "" }, { "a-b", "ab", "-" },
            { "x", "y", " " }, { "a\tb", "ab", " \t" }, { "", "", " " },
        };
        for (i = 0; i < 6; i++) for (j = 0; j < 2; j++) {
            reset_bufs(); strcpy(buf[0], pf[i][0]); strcpy(buf[1], pf[i][1]); strcpy(buf[2], pf[i][2]);
            case_hdr("fuzzymatch", i * 10 + j);
            printf("IN %s ", hexof(pf[i][0], hex0));
            printf("%s ", hexof(pf[i][1], hex0 + 512));
            printf("%s %d\n", hexof(pf[i][2], hex0 + 1024), j);
            pret_int(fuzzymatch(buf[0], buf[1], buf[2], j));
        }
    }

    /* stripchars(bp, stuff, orig) */
    {
        static const char *ps2[][2] = {
            { "aeiou", "abcde AEIOU bcdfg" }, { " ", " a b  c " },
            { "", "unchanged" }, { "xyz", "" }, { "0123456789", "a1b2c3" },
        };
        for (i = 0; i < 5; i++) {
            reset_bufs(); strcpy(buf[1], ps2[i][0]); strcpy(buf[2], ps2[i][1]);
            case_hdr("stripchars", i);
            printf("IN %s ", hexof(ps2[i][0], hex0));
            printf("%s\n", hexof(ps2[i][1], hex0 + 1024));
            pret_ptr(stripchars(buf[0], buf[1], buf[2])); pbuf(0);
        }
    }

    /* strsubst / strNsubst */
    {
        static const char *ps3[][3] = {
            { "hello world", "world", "there" }, { "aaa", "a", "bb" },
            { "nomatch", "x", "y" }, { "ababab", "ab", "X" },
        };
        static const int ns[] = { 0, 1, 2, 99 };
        for (i = 0; i < 4; i++) {
            reset_bufs(); strcpy(buf[0], ps3[i][0]); strcpy(buf[1], ps3[i][1]); strcpy(buf[2], ps3[i][2]);
            case_hdr("strsubst", i);
            printf("IN %s ", hexof(ps3[i][0], hex0));
            printf("%s ", hexof(ps3[i][1], hex0 + 512));
            printf("%s\n", hexof(ps3[i][2], hex0 + 1024));
            pret_ptr(strsubst(buf[0], buf[1], buf[2])); pbuf(0);
            for (j = 0; j < 4; j++) {
                reset_bufs(); strcpy(buf[0], ps3[i][0]); strcpy(buf[1], ps3[i][1]); strcpy(buf[2], ps3[i][2]);
                case_hdr("strNsubst", i * 10 + j);
                printf("IN %s ", hexof(ps3[i][0], hex0));
                printf("%s ", hexof(ps3[i][1], hex0 + 512));
                printf("%s %d\n", hexof(ps3[i][2], hex0 + 1024), ns[j]);
                pret_int(strNsubst(buf[0], buf[1], buf[2], ns[j])); pbuf(0);
            }
        }
        /* orig == "" insertion cases */
        static const int ni[] = { 0, 1, 2, 4, 5 };
        for (j = 0; j < 5; j++) {
            reset_bufs(); strcpy(buf[0], "abc"); strcpy(buf[2], "XY");
            case_hdr("strNsubst", 900 + j);
            printf("IN %s %s %s %d\n", "616263", "", "5859", ni[j]);
            pret_int(strNsubst(buf[0], buf[1], buf[2], ni[j])); pbuf(0);
        }
    }

    /* findword */
    {
        static const char *fw[][2] = {
            { "foo bar baz", "bar" }, { "foo Bar baz", "bar" }, { "foo bar", "ba" },
            { "one two", "two" }, { "x", "y" }, { "  lead  spaces ", "spaces" },
        };
        for (i = 0; i < 6; i++) for (j = 0; j < 2; j++) {
            int wl = (int) strlen(fw[i][1]);
            reset_bufs(); strcpy(buf[0], fw[i][0]); strcpy(buf[1], fw[i][1]);
            case_hdr("findword", i * 10 + j);
            printf("IN %s ", hexof(fw[i][0], hex0));
            printf("%s %d %d\n", hexof(fw[i][1], hex0 + 1024), wl, j);
            pret_ptr(findword(buf[0], buf[1], wl, j));
        }
    }

    /* int -> string/int */
    {
        static const int oi[] = { -1, 0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100, 111, 112, 113, 1000, 1001 };
        for (i = 0; i < 18; i++) {
            case_hdr("ordin", i); printf("IN %d\n", oi[i]); pret_ptr(ordin(oi[i]));
        }
        static const int si[] = { 0, 1, -1, 42, -999, INT_MAX, INT_MIN };
        for (i = 0; i < 7; i++) {
            case_hdr("sitoa", i); printf("IN %d\n", si[i]); pret_ptr(sitoa(si[i]));
            case_hdr("sgn", i); printf("IN %d\n", si[i]); pret_int(sgn(si[i]));
        }
        static const int qi[] = { 0, 1, 2, 3, 4, 15, 16, 17, 1000000, 2147395600, INT_MAX };
        for (i = 0; i < 11; i++) {
            case_hdr("isqrt", i); printf("IN %d\n", qi[i]); pret_int(isqrt(qi[i]));
        }
    }

    /* coord functions */
    {
        static const int co[][4] = {
            { 0, 0, 3, 4 }, { 5, 5, 5, 5 }, { -2, 3, 4, -5 }, { 10, 0, -10, 0 }, { -7, -8, -7, -9 },
        };
        for (i = 0; i < 5; i++) {
            case_hdr("distmin", i);
            printf("IN %d %d %d %d\n", co[i][0], co[i][1], co[i][2], co[i][3]);
            pret_int(distmin(co[i][0], co[i][1], co[i][2], co[i][3]));
            case_hdr("dist2", i);
            printf("IN %d %d %d %d\n", co[i][0], co[i][1], co[i][2], co[i][3]);
            pret_int(dist2(co[i][0], co[i][1], co[i][2], co[i][3]));
            case_hdr("online2", i);
            printf("IN %d %d %d %d\n", co[i][0], co[i][1], co[i][2], co[i][3]);
            pret_int(online2(co[i][0], co[i][1], co[i][2], co[i][3]));
        }
    }

    /* swapbits */
    {
        static const int sw[][3] = {
            { 10, 1, 3 }, { 0xFF, 0, 7 }, { 0, 1, 2 }, { 0x12345678, 3, 20 }, { -1, 0, 31 },
        };
        for (i = 0; i < 5; i++) {
            case_hdr("swapbits", i);
            printf("IN %d %d %d\n", sw[i][0], sw[i][1], sw[i][2]);
            pret_int(swapbits(sw[i][0], sw[i][1], sw[i][2]));
        }
    }

    /* case_insensitive_comp */
    {
        static const char *cc[][2] = {
            { "abc", "ABC" }, { "Abc", "aBd" }, { "", "x" }, { "a", "" },
            { "ABC123", "abc124" }, { "Z", "[" }, { "", "" },
        };
        for (i = 0; i < 7; i++) {
            reset_bufs(); strcpy(buf[0], cc[i][0]); strcpy(buf[1], cc[i][1]);
            case_hdr("case_insensitive_comp", i);
            printf("IN %s ", hexof(cc[i][0], hex0));
            printf("%s\n", hexof(cc[i][1], hex0 + 1024));
            pret_int(case_insensitive_comp(buf[0], buf[1]));
        }
    }

    /* unicodeval_to_utf8str */
    {
        static const long uv[] = { 0x41, 0x7F, 0x80, 0x7FF, 0x800, 0xD7FF, 0xD800,
                                   0xDFFF, 0xE000, 0xFFFF, 0x10000, 0x10FFFF, 0x110000, 0 };
        for (i = 0; uv[i] || i == 0; i++) {
            reset_bufs();
            case_hdr("unicodeval_to_utf8str", i);
            printf("IN %ld %d\n", uv[i], 8);
            pret_int(unicodeval_to_utf8str((int) uv[i], (uint8 *) buf[0], 8)); pbuf(0);
            if (i > 0 && uv[i + 1] == 0) break;
        }
        reset_bufs();
        case_hdr("unicodeval_to_utf8str", 900);
        printf("IN %d %d\n", 0x41, 4);
        pret_int(unicodeval_to_utf8str(0x41, (uint8 *) buf[0], 4)); pbuf(0);
    }

    /* nh_snprintf (fixed varargs cases) */
    {
        reset_bufs();
        case_hdr("nh_snprintf", 0);
        printf("IN fixed\n");
        nh_snprintf("battery", 1, buf[0], 32, "%d|%s", 42, "hi");
        pbuf(0);
        reset_bufs();
        case_hdr("nh_snprintf", 1);
        printf("IN fixed\n");
        nh_snprintf("battery", 2, buf[0], 8, "%d|%s", 42, "hi"); /* truncation */
        pbuf(0);
        reset_bufs();
        case_hdr("nh_snprintf", 2);
        printf("IN fixed\n");
        nh_snprintf("battery", 3, buf[0], 4, "%s", "a longer string"); /* n < 0||overflow path */
        pbuf(0);
        reset_bufs();
        case_hdr("nh_snprintf", 3);
        printf("IN fixed\n");
        nh_snprintf("battery", 4, buf[0], 64, "+%d %c %%", 7, 'q');
        pbuf(0);
    }

    /* nh_deterministic_qsort over int32 elements with ties */
    {
        static const int vals[] = { 5, 3, 3, 1, 4, 2, 8, 3, 0, -7, 3, 100, -100, 6 };
        int data[14];
        case_hdr("nh_deterministic_qsort", 0);
        printf("IN fixed\n");
        memcpy(data, vals, sizeof vals);
        nh_deterministic_qsort(data, 14, sizeof(int), 0); /* null compar: no-op */
        printf("RET int:0\n"); /* guard path only */
        memcpy(data, vals, sizeof vals);
        case_hdr("nh_deterministic_qsort", 1);
        printf("IN fixed\n");
        {
            extern int battery_intcmp(const void *, const void *);
            nh_deterministic_qsort(data, 14, sizeof(int), battery_intcmp);
        }
        printf("DATA ");
        phexn((const unsigned char *) data, (long) sizeof data);
        printf("\n");
    }

    /* copy_bytes over in-memory files */
    {
        static const int lens[] = { 0, 1, 100, 1023, 1024, 1025, 2048, 3000 };
        for (i = 0; i < 8; i++) {
            FILE *fsrc = tmpfile(), *fdst = tmpfile();
            long n;
            unsigned char *content = malloc(lens[i] ? lens[i] : 1);
            unsigned char *back = malloc(lens[i] ? lens[i] : 1);
            for (j = 0; j < lens[i]; j++) content[j] = (unsigned char) (j * 7 + 3);
            case_hdr("copy_bytes", i);
            printf("IN %d\n", lens[i]);
            fwrite(content, 1, lens[i], fsrc);
            rewind(fsrc);
            pret_int(copy_bytes(fileno(fsrc), fileno(fdst)));
            fflush(fdst);
            n = ftell(fdst);
            rewind(fdst);
            fread(back, 1, lens[i], fdst);
            printf("DATA ");
            phexn(back, n);
            printf("\n");
            fclose(fsrc); fclose(fdst);
            free(content); free(back);
        }
    }

    /* datamodel */
    case_hdr("datamodel", 0); printf("IN %d\n", 0); pret_ptr(datamodel(0));
    case_hdr("datamodel", 1); printf("IN %d\n", 1); pret_ptr(datamodel(1));
    case_hdr("what_datamodel_is_this", 0);
    printf("IN %d %d %d %d %d %d\n", 0, 2, 4, 8, 8, 8);
    pret_ptr(what_datamodel_is_this(0, 2, 4, 8, 8, 8));
    case_hdr("what_datamodel_is_this", 1);
    printf("IN %d %d %d %d %d %d\n", 1, 2, 4, 4, 8, 4);
    pret_ptr(what_datamodel_is_this(1, 2, 4, 4, 8, 4));
    case_hdr("what_datamodel_is_this", 2);
    printf("IN %d %d %d %d %d %d\n", 0, 9, 9, 9, 9, 9);
    pret_ptr(what_datamodel_is_this(0, 9, 9, 9, 9, 9));

    return 0;
}

int
battery_intcmp(const void *a, const void *b)
{
    int x = *(const int *) a, y = *(const int *) b;
    return (x > y) - (x < y);
}
