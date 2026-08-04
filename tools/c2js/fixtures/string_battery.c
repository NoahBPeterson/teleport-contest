/* string_battery.c — differential battery driver for the C string/memory/ctype
 * functions mirrored by js/libc/string.js.
 *
 * Prints a line-based transcript, one block per case:
 *   # <fn> <idx>
 *   IN <tok> ...     tok = s<k>:<hex>  (NUL-terminated string at buf k, off 0)
 *                          b<k>:<off>:<hex>  (raw bytes at buf k, off)
 *                          i:<v>   (int arg)   n:<v>   (size_t arg)
 *   RET int:<v> | RET size:<v> | RET ptr:<k>:<off> | RET null
 *   BUF0 <hex> BUF1 <hex> BUF2 <hex>      (full 64-byte dumps, always)
 *
 * The JS harness (test/libc-string.test.mjs) replays every IN line through
 * js/libc/string.js over Uint8Array buffers and diffs the RET/BUF lines
 * byte-for-byte against this transcript. Batteries are fully deterministic.
 *
 * Build + run (from repo root):
 *   clang tools/c2js/fixtures/string_battery.c -o .cache/c2js/build/string_battery
 *   .cache/c2js/build/string_battery
 */
#include <stdio.h>
#include <string.h>
#include <ctype.h>

#define NBUF 3
#define BSZ 64
static unsigned char buf[NBUF][BSZ];

static void reset_bufs(void) { memset(buf, 0, sizeof buf); }

static void case_hdr(const char *fn, int idx) { printf("# %s %d\n", fn, idx); }

static void phex(const unsigned char *p, long n) {
    long i;
    for (i = 0; i < n; i++) printf("%02x", p[i]);
}

/* ---- IN-token emitters (mirror what place_* do) ---- */
static void emit_s(int k, const char *s) {
    const unsigned char *u = (const unsigned char *) s;
    printf(" s%d:", k);
    for (; *u; u++) printf("%02x", *u);
}
static void emit_b(int k, int off, const unsigned char *d, int len) {
    int i;
    printf(" b%d:%d:", k, off);
    for (i = 0; i < len; i++) printf("%02x", d[i]);
}
static void emit_i(int v) { printf(" i:%d", v); }
static void emit_n(size_t v) { printf(" n:%zu", v); }

/* ---- placements ---- */
static void place_s(int k, const char *s) { strcpy((char *) buf[k], s); }
static void place_b(int k, int off, const unsigned char *d, int len) {
    memcpy(buf[k] + off, d, len);
}

/* ---- output lines ---- */
static void ret_int(long v) { printf("RET int:%ld\n", v); }
static void ret_size(size_t v) { printf("RET size:%zu\n", v); }
static void ret_ptr(const void *p) {
    int k;
    if (!p) { printf("RET null\n"); return; }
    for (k = 0; k < NBUF; k++) {
        if ((const unsigned char *) p >= buf[k] && (const unsigned char *) p < buf[k] + BSZ) {
            printf("RET ptr:%d:%ld\n", k, (long) ((const unsigned char *) p - buf[k]));
            return;
        }
    }
    printf("RET other\n");
}
static void dump(void) {
    int k;
    for (k = 0; k < NBUF; k++) {
        printf("BUF%d ", k);
        phex(buf[k], BSZ);
        printf("\n");
    }
}

#define BEGIN(fn, idx) do { reset_bufs(); case_hdr((fn), (idx)); printf("IN"); } while (0)
#define END() do { printf("\n"); } while (0)

/* ---- battery data ------------------------------------------------------ */

static const char *STRS[] = {
    "", "a", "ab", "abc", "aBc", "ABC", "AbC123", "hello world",
    "Hello World", "  lead", "trail  ", "  a  b  c  ", "a\tb", "\tlead",
    "ababab", "aaa", "aaax", "xxaax", "the quick brown fox", "0123456789",
    "ZebraZEBRA", "a" "\x80" "z", "\x80\xFF", "\xFF\x80\xA5", "caf\xC3\xA9",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
static const int NSTRS = (int) (sizeof STRS / sizeof STRS[0]);

/* selected string indices for the search/comparison batteries */
static const int S_SEL[] = { 0, 1, 2, 4, 7, 8, 13, 15, 17, 18, 21, 22, 24, 25 };
static const int NS_SEL = (int) (sizeof S_SEL / sizeof S_SEL[0]);

static const char *PAIRS[][2] = {
    { "", "" }, { "", "a" }, { "a", "" }, { "a", "a" }, { "a", "b" },
    { "b", "a" }, { "abc", "abc" }, { "abc", "abd" }, { "abd", "abc" },
    { "abc", "abcd" }, { "abcd", "abc" }, { "ABC", "abc" }, { "abc", "ABC" },
    { "aBc", "AbC" }, { "hello", "hell" }, { "\x80", "\x81" }, { "\x81", "\x80" },
    { "\x80", "a" }, { "\xFF\x80", "\xFF\x81" }, { "a\x80", "a\x7F" },
    { "Zebra", "zebra" }, { "abc", "ab" },
};
static const int NPAIRS = (int) (sizeof PAIRS / sizeof PAIRS[0]);

static const int NP_SEL[] = { 0, 1, 2, 3, 7, 8, 10, 12, 15, 16, 20 };
static const int NNP = (int) (sizeof NP_SEL / sizeof NP_SEL[0]);
static const size_t NP_N[] = { 0, 1, 3, 7, 100 };
static const int NNP_N = (int) (sizeof NP_N / sizeof NP_N[0]);

static const char *CIP[][2] = {
    { "", "" }, { "", "A" }, { "A", "" }, { "a", "A" }, { "A", "a" },
    { "aBc", "AbC" }, { "abc", "ABC" }, { "Zebra", "zebra" }, { "hello", "HELLO" },
    { "abc", "abd" }, { "\x80", "\x80" }, { "\x80\xFF", "\x80\xFF" },
    { "\xC3\xA9", "\xC3\xA9" }, { "a\x80", "A\x80" }, { "ABC", "abcD" },
    { "abcD", "ABC" },
};
static const int NCIP = (int) (sizeof CIP / sizeof CIP[0]);

static const char *NCP[][2] = {
    { "", "" }, { "abc", "ABC" }, { "ABC", "abc" }, { "abc", "ABD" },
    { "ab", "abc" }, { "abc", "ab" }, { "Zebra", "zebRA" }, { "\x80\xFF", "\x80\xFF" },
    { "a\x80", "A\x81" }, { "hello", "HELLO" },
};
static const int NNCP = (int) (sizeof NCP / sizeof NCP[0]);
static const size_t NCN[] = { 0, 1, 3, 5, 100 };
static const int NNCN = (int) (sizeof NCN / sizeof NCN[0]);

static const int CHRC[] = { 'a', 'A', ' ', 0, '\t', 'z', 'e', 0x80, 0xFF, 'b', 'x', 'Z' };
static const int NCHRC = (int) (sizeof CHRC / sizeof CHRC[0]);

static const char *SSP[][2] = {
    { "hello world", "world" }, { "hello world", "hello" }, { "hello world", "world!" },
    { "hello world", "lo wo" }, { "aaaa", "aa" }, { "abc", "" }, { "", "" },
    { "", "x" }, { "aaa", "aaa" }, { "aaa", "aaaa" }, { "xab", "ab" },
    { "ab", "ab" }, { "the quick brown fox", "quick" }, { "\x80\xFF\x80", "\xFF" },
    { "aaa", "baa" }, { "baa", "aa" },
};
static const int NSSP = (int) sizeof SSP / sizeof SSP[0];

static const char *ACC[] = { "abc", " ", "", "a", "hello ", "\x80\xFF" };
static const int NACC = (int) sizeof ACC / sizeof ACC[0];

static const unsigned char MB1[] = { 'a', 'b', 0, 'c', 'd' };
static const unsigned char MB2[] = { 0x80, 0xFF, 0, 0xA5, 0xC3 };
static const unsigned char MB3[] = { 0, 0, 0, 0 };
static const unsigned char MB4[] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
static const size_t MBN[] = { 0, 1, 3, 5, 8 };
static const int NMBN = (int) sizeof MBN / sizeof MBN[0];

static const unsigned char MPAT1[20] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
                                        10, 11, 12, 13, 14, 15, 16, 17, 18, 19 };
static const unsigned char MPAT2[8] = { 0xFF, 0x80, 0x00, 0xC3, 0xA9, 0x41, 0x5A, 0x7F };

static const unsigned char MCA[] = { 1, 2, 3, 4, 5 };
static const unsigned char MCB[] = { 1, 2, 3, 4, 6 };
static const unsigned char MCC[] = { 0x80, 0x81 };
static const unsigned char MCD[] = { 0x80, 0x80 };
static const size_t MCP_N[] = { 0, 1, 2, 3, 5, 8 };
static const int NMCP_N = (int) sizeof MCP_N / sizeof MCP_N[0];

static const int CT[] = { -1, 0, 7, 8, 9, 10, 11, 12, 13, 14, 31, 32, 33,
                          47, 48, 57, 58, 64, 65, 70, 71, 90, 91, 95, 96,
                          97, 100, 102, 103, 122, 123, 126, 127, 128,
                          0xA5, 0xC3, 0xFF };
static const int NCT = (int) (sizeof CT / sizeof CT[0]);

/* ---- batteries --------------------------------------------------------- */

static void battery_strlen(void) {
    int i;
    for (i = 0; i < NSTRS; i++) {
        BEGIN("strlen", i);
        place_s(0, STRS[i]);
        emit_s(0, STRS[i]);
        END();
        ret_size(strlen((char *) buf[0]));
        dump();
    }
}

static void battery_strcpy(void) {
    int i;
    for (i = 0; i < NS_SEL; i++) {
        BEGIN("strcpy", i);
        place_s(0, STRS[S_SEL[i]]);
        place_s(1, "");
        emit_s(1, "");
        emit_s(0, STRS[S_SEL[i]]);
        END();
        ret_ptr(strcpy((char *) buf[1], (char *) buf[0]));
        dump();
    }
}

static void battery_strncpy(void) {
    static const int src[] = { 0, 2, 4, 7, 16, 22 };
    static const size_t nn[] = { 0, 1, 3, 5, 10 };
    int i, j;
    for (i = 0; i < 6; i++) for (j = 0; j < 5; j++) {
        BEGIN("strncpy", i * 10 + j);
        place_s(0, STRS[src[i]]);
        place_s(1, "");
        emit_s(1, "");
        emit_s(0, STRS[src[i]]);
        emit_n(nn[j]);
        END();
        ret_ptr(strncpy((char *) buf[1], (char *) buf[0], nn[j]));
        dump();
    }
}

static void battery_strcat(void) {
    static const int dst[] = { 0, 1, 7 };
    static const int src[] = { 0, 2, 7, 21, 22 };
    int i, j;
    for (i = 0; i < 3; i++) for (j = 0; j < 5; j++) {
        BEGIN("strcat", i * 10 + j);
        place_s(0, STRS[dst[i]]);
        place_s(1, STRS[src[j]]);
        emit_s(0, STRS[dst[i]]);
        emit_s(1, STRS[src[j]]);
        END();
        ret_ptr(strcat((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_strncat(void) {
    static const int dst[] = { 0, 1 };
    static const int src[] = { 7, 2, 22 };
    static const size_t nn[] = { 0, 1, 3, 5, 20 };
    int i, j, k;
    for (i = 0; i < 2; i++) for (j = 0; j < 3; j++) for (k = 0; k < 5; k++) {
        BEGIN("strncat", i * 100 + j * 10 + k);
        place_s(0, STRS[dst[i]]);
        place_s(1, STRS[src[j]]);
        emit_s(0, STRS[dst[i]]);
        emit_s(1, STRS[src[j]]);
        emit_n(nn[k]);
        END();
        ret_ptr(strncat((char *) buf[0], (char *) buf[1], nn[k]));
        dump();
    }
}

static void battery_strcmp(void) {
    int i;
    for (i = 0; i < NPAIRS; i++) {
        BEGIN("strcmp", i);
        place_s(0, PAIRS[i][0]);
        place_s(1, PAIRS[i][1]);
        emit_s(0, PAIRS[i][0]);
        emit_s(1, PAIRS[i][1]);
        END();
        ret_int(strcmp((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_strncmp(void) {
    int i, j;
    for (i = 0; i < NNP; i++) for (j = 0; j < NNP_N; j++) {
        const char *a = PAIRS[NP_SEL[i]][0], *b = PAIRS[NP_SEL[i]][1];
        BEGIN("strncmp", i * 10 + j);
        place_s(0, a);
        place_s(1, b);
        emit_s(0, a);
        emit_s(1, b);
        emit_n(NP_N[j]);
        END();
        ret_int(strncmp((char *) buf[0], (char *) buf[1], NP_N[j]));
        dump();
    }
}

static void battery_strcasecmp(void) {
    int i;
    for (i = 0; i < NCIP; i++) {
        BEGIN("strcasecmp", i);
        place_s(0, CIP[i][0]);
        place_s(1, CIP[i][1]);
        emit_s(0, CIP[i][0]);
        emit_s(1, CIP[i][1]);
        END();
        ret_int(strcasecmp((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_strncasecmp(void) {
    int i, j;
    for (i = 0; i < NNCP; i++) for (j = 0; j < NNCN; j++) {
        BEGIN("strncasecmp", i * 10 + j);
        place_s(0, NCP[i][0]);
        place_s(1, NCP[i][1]);
        emit_s(0, NCP[i][0]);
        emit_s(1, NCP[i][1]);
        emit_n(NCN[j]);
        END();
        ret_int(strncasecmp((char *) buf[0], (char *) buf[1], NCN[j]));
        dump();
    }
}

static void battery_strchr(void) {
    int i, j;
    for (i = 0; i < NS_SEL; i++) for (j = 0; j < NCHRC; j++) {
        BEGIN("strchr", i * 100 + j);
        place_s(0, STRS[S_SEL[i]]);
        emit_s(0, STRS[S_SEL[i]]);
        emit_i(CHRC[j]);
        END();
        ret_ptr(strchr((char *) buf[0], CHRC[j]));
        dump();
    }
}

static void battery_strrchr(void) {
    int i, j;
    for (i = 0; i < NS_SEL; i++) for (j = 0; j < NCHRC; j++) {
        BEGIN("strrchr", i * 100 + j);
        place_s(0, STRS[S_SEL[i]]);
        emit_s(0, STRS[S_SEL[i]]);
        emit_i(CHRC[j]);
        END();
        ret_ptr(strrchr((char *) buf[0], CHRC[j]));
        dump();
    }
}

static void battery_strstr(void) {
    int i;
    for (i = 0; i < NSSP; i++) {
        BEGIN("strstr", i);
        place_s(0, SSP[i][0]);
        place_s(1, SSP[i][1]);
        emit_s(0, SSP[i][0]);
        emit_s(1, SSP[i][1]);
        END();
        ret_ptr(strstr((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_strspn(void) {
    int i, j;
    for (i = 0; i < NS_SEL; i++) for (j = 0; j < NACC; j++) {
        BEGIN("strspn", i * 10 + j);
        place_s(0, STRS[S_SEL[i]]);
        place_s(1, ACC[j]);
        emit_s(0, STRS[S_SEL[i]]);
        emit_s(1, ACC[j]);
        END();
        ret_size(strspn((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_strcspn(void) {
    int i, j;
    for (i = 0; i < NS_SEL; i++) for (j = 0; j < NACC; j++) {
        BEGIN("strcspn", i * 10 + j);
        place_s(0, STRS[S_SEL[i]]);
        place_s(1, ACC[j]);
        emit_s(0, STRS[S_SEL[i]]);
        emit_s(1, ACC[j]);
        END();
        ret_size(strcspn((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_strpbrk(void) {
    int i, j;
    for (i = 0; i < NS_SEL; i++) for (j = 0; j < NACC; j++) {
        BEGIN("strpbrk", i * 10 + j);
        place_s(0, STRS[S_SEL[i]]);
        place_s(1, ACC[j]);
        emit_s(0, STRS[S_SEL[i]]);
        emit_s(1, ACC[j]);
        END();
        ret_ptr(strpbrk((char *) buf[0], (char *) buf[1]));
        dump();
    }
}

static void battery_memcpy(void) {
    static const unsigned char *BLOBS[] = { MB1, MB2, MB3 };
    static const int BLEN[] = { 5, 5, 4 };
    int i, j;
    for (i = 0; i < 3; i++) for (j = 0; j < NMBN; j++) {
        BEGIN("memcpy", i * 10 + j);
        place_b(0, 0, BLOBS[i], BLEN[i]);
        place_b(2, 0, (const unsigned char *) "", 0);
        emit_b(0, 0, BLOBS[i], BLEN[i]);
        emit_b(2, 0, (const unsigned char *) "", 0);
        emit_n(MBN[j]);
        END();
        ret_ptr(memcpy(buf[2], buf[0], MBN[j]));
        dump();
    }
}

static void battery_memmove(void) {
    static const struct { const unsigned char *d; int len; int dst; int src; size_t n; } C1[] = {
        { MPAT1, 20, 0, 0, 20 },   /* dst == src */
        { MPAT1, 20, 0, 10, 10 },  /* dst < src */
        { MPAT1, 20, 10, 0, 10 },  /* dst > src */
        { MPAT1, 20, 5, 10, 10 },  /* dst < src, overlap */
        { MPAT1, 20, 12, 4, 8 },   /* dst > src, overlap */
        { MPAT1, 20, 0, 20, 20 },  /* dst < src, adjacent */
        { MPAT1, 20, 20, 0, 20 },  /* dst > src, adjacent */
        { MPAT1, 20, 40, 0, 10 },  /* dst > src, far */
        { MPAT1, 20, 0, 40, 10 },  /* dst < src, far */
        { MPAT2, 8, 0, 0, 8 },
        { MPAT2, 8, 0, 4, 4 },
        { MPAT2, 8, 4, 0, 4 },
        { MPAT2, 8, 6, 2, 4 },
        { MPAT2, 8, 2, 6, 4 },
    };
    int i;
    for (i = 0; i < 14; i++) {
        BEGIN("memmove", i);
        place_b(0, 0, C1[i].d, C1[i].len);
        emit_b(0, 0, C1[i].d, C1[i].len);
        emit_i(C1[i].dst);
        emit_i(C1[i].src);
        emit_n(C1[i].n);
        END();
        ret_ptr(memmove(buf[0] + C1[i].dst, buf[0] + C1[i].src, C1[i].n));
        dump();
    }
}

static void battery_memset(void) {
    static const int MC[] = { 0, 0x41, 0x80, 0xFF };
    static const size_t MN[] = { 0, 1, 7, 16, 64 };
    int i, j;
    for (i = 0; i < 4; i++) for (j = 0; j < 5; j++) {
        BEGIN("memset", i * 10 + j);
        place_b(0, 0, (const unsigned char *) "", 0);
        emit_b(0, 0, (const unsigned char *) "", 0);
        emit_i(MC[i]);
        emit_n(MN[j]);
        END();
        ret_ptr(memset(buf[0], MC[i], MN[j]));
        dump();
    }
}

static void battery_memcmp(void) {
    static const unsigned char *A[] = { MCA, MCA, MCC, MCA };
    static const unsigned char *B[] = { MCB, MCA, MCD, MCC };
    static const int LA[] = { 5, 5, 2, 5 };
    static const int LB[] = { 5, 5, 2, 2 };
    int i, j;
    for (i = 0; i < 4; i++) for (j = 0; j < NMCP_N; j++) {
        BEGIN("memcmp", i * 10 + j);
        place_b(0, 0, A[i], LA[i]);
        place_b(1, 0, B[i], LB[i]);
        emit_b(0, 0, A[i], LA[i]);
        emit_b(1, 0, B[i], LB[i]);
        emit_n(MCP_N[j]);
        END();
        ret_int(memcmp(buf[0], buf[1], MCP_N[j]));
        dump();
    }
}

static void battery_memchr(void) {
    static const unsigned char *BLOBS[] = { MB1, MB2, MB4 };
    static const int BLEN[] = { 5, 5, 16 };
    static const int C[] = { 0, 0xFF, 'a', 0x80 };
    static const size_t N[] = { 0, 2, 8, 16 };
    int i, j, k;
    for (i = 0; i < 3; i++) for (j = 0; j < 4; j++) for (k = 0; k < 4; k++) {
        BEGIN("memchr", i * 100 + j * 10 + k);
        place_b(0, 0, BLOBS[i], BLEN[i]);
        emit_b(0, 0, BLOBS[i], BLEN[i]);
        emit_i(C[j]);
        emit_n(N[k]);
        END();
        ret_ptr(memchr(buf[0], C[j], N[k]));
        dump();
    }
}

static void battery_ctype(void) {
    static const char *FNS[] = { "isalpha", "isdigit", "isalnum", "isspace",
                                 "isupper", "islower", "isxdigit", "toupper", "tolower" };
    int i, j;
    for (i = 0; i < 9; i++) for (j = 0; j < NCT; j++) {
        BEGIN(FNS[i], j);
        emit_i(CT[j]);
        END();
        switch (i) {
        case 0: ret_int(isalpha(CT[j])); break;
        case 1: ret_int(isdigit(CT[j])); break;
        case 2: ret_int(isalnum(CT[j])); break;
        case 3: ret_int(isspace(CT[j])); break;
        case 4: ret_int(isupper(CT[j])); break;
        case 5: ret_int(islower(CT[j])); break;
        case 6: ret_int(isxdigit(CT[j])); break;
        case 7: ret_int(toupper(CT[j])); break;
        case 8: ret_int(tolower(CT[j])); break;
        }
        dump();
    }
}

int
main(void)
{
    battery_strlen();
    battery_strcpy();
    battery_strncpy();
    battery_strcat();
    battery_strncat();
    battery_strcmp();
    battery_strncmp();
    battery_strcasecmp();
    battery_strncasecmp();
    battery_strchr();
    battery_strrchr();
    battery_strstr();
    battery_strspn();
    battery_strcspn();
    battery_strpbrk();
    battery_memcpy();
    battery_memmove();
    battery_memset();
    battery_memcmp();
    battery_memchr();
    battery_ctype();
    return 0;
}
