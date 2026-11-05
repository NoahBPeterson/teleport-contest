/* torture_gate.c — c2js fixture: contrived C edge cases.
 *
 * Unlike the other gates, these were written up front from the C standard and
 * the Darwin ABI, not from a bug already found. Everything here is defined or
 * implementation-defined on arm64 Darwin (no signed overflow, no strict
 * aliasing games beyond char views and unions). Prints a trace; the transpiled
 * JS must match byte-for-byte.
 */
#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

typedef unsigned char boolean;
#define T(fmt, ...) printf("%-4d " fmt "\n", __LINE__, __VA_ARGS__)

/* ---- integer promotion and conversion ---------------------------------- */
static void promotions(void)
{
    unsigned char uc = 200, uc2 = 100;
    signed char sc = -56;
    short sh = -1;
    unsigned short us = 65535;
    unsigned u = 1;
    int i = -1;
    long l = -1;
    unsigned long ul = 1;

    T("%d", uc + uc2);                 /* 300: promoted, no wrap */
    T("%d", (unsigned char) (uc + uc2));
    T("%d", ~uc);                      /* -201 */
    T("%d", (unsigned char) ~uc);
    T("%d", -uc);
    T("%d", sc >> 1);
    T("%d", (unsigned char) sc >> 1);
    T("%u", (unsigned) us * us);
    T("%d", i < u);                    /* 0: -1 converts to UINT_MAX */
    T("%d", sh < us);
    T("%d", l < (long) u);
    T("%d", l < ul);                   /* 0 */
    T("%d", (char) 200);
    T("%d", (short) 70000);
    T("%d", (signed char) 0x80);
    T("%u", (unsigned) -1);
    T("%lu", (unsigned long) -1);
    T("%lu", (unsigned long) (int) -1);
    T("%lu", (unsigned long) (unsigned) -1);
    T("%ld", (long) (unsigned) -1);
    T("%d", (int) (unsigned) 0x80000000);
    T("%d", sizeof(uc + uc2) == sizeof(int));
    T("%d", sizeof(uc ? uc : sc) == sizeof(int));
    T("%d", (boolean) 256);
    T("%d", !!256);
    T("%u", (i < 0 ? u : 0u) - 2u);
    T("%ld", (i < 0 ? -1 : 1UL) == ULONG_MAX ? 1L : 0L);
}

/* ---- division, shift, wrap --------------------------------------------- */
static void arith(void)
{
    int a = -7, b = 2;
    unsigned u = 0xFFFFFFFFu;
    long long ll = LLONG_MAX;
    unsigned long long ull = ULLONG_MAX;
    int imax = INT_MAX;
    int vals[] = { -9, -8, -1, 0, 1, 7, 8 };
    size_t n;

    T("%d %d %d %d", a / b, a % b, -a / -b, 7 % -2);
    T("%d %d", a >> 1, a >> 31);
    T("%u %u", u >> 31, u << 31);
    T("%u %u", u + 1, u * u);
    T("%llu", ull + 2);
    T("%lld", ll / 3);
    T("%lld", ll % 1000);
    T("%lld", -ll - 1);
    T("%llu", ull / 7);
    T("%llu", ull >> 63);
    T("%lld", (long long) imax * imax);
    T("%d", (int) ((long long) imax * 3));  /* implementation-defined truncation */
    T("%u", (unsigned) imax * 3u);
    T("%d", imax / -1);
    for (n = 0; n < sizeof vals / sizeof *vals; n++)
        T("%d %d %d %u", vals[n] / 3, vals[n] % 3, vals[n] >> 2, (unsigned) vals[n] >> 28);
    T("%d", 1 << 30);
    T("%u", 1u << 31);
    T("%lld", 1LL << 40);
    T("%d", (a & 0xFF) | (b << 8));
    T("%d", a ^ b);
    T("%d", ~a);
}

/* ---- floating point ---------------------------------------------------- */
static void floats(void)
{
    float f = 0.1f, g = 16777217.0f;
    double d = 0.1;
    double big = 3000000000.0;
    int i;

    T("%.17g", (double) f);
    T("%.17g", f + 0.2f);
    T("%.17g", (double) (f * f));
    T("%.17g", d + 0.2);
    T("%.17g", (double) g);
    T("%d %d %d", (int) 2.9, (int) -2.9, (int) 2.5f);
    T("%u", (unsigned) big);
    T("%ld", (long) big);
    T("%d", (char) 65.9);
    i = 7;
    T("%.17g", i / 2 * 1.5);
    T("%.17g", i * 1.5 / 2);
    T("%d", f == 0.1);
    T("%d", (float) d == f);
    T("%g %e %f", 1e21, 1.5e-7, 2.5);
    T("%5.2f|%-8.3e|%+g", 3.14159, 1234.5, 2.0);
}

/* ---- structs, bitfields, layout ---------------------------------------- */
struct bits {
    unsigned a : 3;
    int b : 3;
    unsigned c : 1;
    unsigned char d;
    unsigned e : 12;
    boolean f : 1;
};
struct inner { short s; char c; };
struct outer { char tag; struct inner in[2]; long l; int arr[3]; char name[5]; };
union pun { int i; unsigned char b[4]; short s[2]; float f; };

static struct outer mk_outer(int x)
{
    struct outer o;

    memset(&o, 0, sizeof o);
    o.tag = (char) x;
    o.in[1].s = (short) (x * 2);
    o.arr[2] = x * 3;
    strcpy(o.name, "abcd");
    return o;
}

static void structs(void)
{
    struct bits bf;
    struct outer o = mk_outer(5), o2;
    struct outer os[3];
    struct outer *p = os;
    union pun u;
    int *ip;
    char *cp;

    memset(&bf, 0, sizeof bf);
    bf.a = 9;       /* truncates to 1 */
    bf.b = 7;       /* -1 */
    bf.c = 3;       /* 1 */
    bf.d = 300 & 0xFF;
    bf.e = 4097;    /* 1 */
    bf.f = 1;
    T("%d %d %d %d %d %d", bf.a, bf.b, bf.c, bf.d, bf.e, bf.f);
    bf.a += 7;
    T("%d", bf.a);
    bf.b--;
    T("%d", bf.b);
    T("%zu %zu %zu", sizeof(struct bits), sizeof(struct inner), sizeof(struct outer));

    o2 = o;                      /* struct copy is deep for arrays */
    o2.arr[2] = 99;
    o2.name[0] = 'Z';
    T("%d %d %s %s", o.arr[2], o2.arr[2], o.name, o2.name);
    os[0] = mk_outer(1);
    os[1] = mk_outer(2);
    os[2] = os[1];
    p++;
    T("%d %d", p->tag, (p + 1)->in[1].s);
    T("%ld %ld", (long) (p - os), (long) (&os[2] - p));
    T("%ld", (long) ((char *) &os[1] - (char *) &os[0]));
    ip = &os[1].arr[1];
    ip[1] = 77;
    T("%d %d", os[1].arr[2], *(ip - 1));
    cp = (char *) &os[1].arr[2];
    T("%d", cp[0] & 0xFF);       /* little-endian byte view */

    u.i = 0x01020304;
    T("%d %d %d %d", u.b[0], u.b[3], u.s[0], u.s[1]);
    u.f = 1.0f;
    T("%x", u.i);
    u.b[3] = 0x40;
    T("%g", (double) u.f);
}

/* ---- pointers, arrays, strings ----------------------------------------- */
static int sum2d(int (*m)[3], int rows)
{
    int r, c, s = 0;

    for (r = 0; r < rows; r++)
        for (c = 0; c < 3; c++)
            s += m[r][c] * (r + 1);
    return s;
}
static int adder(int a, int b) { return a + b; }
static int subber(int a, int b) { return a - b; }
static int (*pick(int w))(int, int) { return w ? adder : subber; }
static int cmp_int(const void *a, const void *b)
{
    return *(const int *) a - *(const int *) b;
}

static void pointers(void)
{
    int m[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } };
    int *flat = &m[0][0];
    int v[5] = { 1, 2 };   /* rest zero */
    char s[] = "hello";
    char buf[32];
    const char *lit = "a\0b";
    char *names[] = { "one", "two", "three" };
    char **pp = names;
    int q[] = { 5, -3, 9, 0, 2 };
    int (*fns[2])(int, int) = { adder, subber };
    int i = 0;

    T("%d %d %d %d", flat[1], *(flat + 2), flat[4], sum2d(m, 2));
    T("%d %d", v[4], v[1]);
    T("%zu %zu %zu", sizeof s, strlen(s), sizeof lit);
    T("%zu %d", strlen(lit), lit[2]);
    s[0] = 'J';
    T("%s %c %c", s, *s, *(s + 4));
    T("%s %c %s", *pp, *pp[1], *(pp + 2));
    T("%c", (*++pp)[1]);
    T("%d %d", pick(1)(7, 2), (*pick(0))(7, 2));
    T("%d %d", fns[1](1, 2), (*fns[0])(1, 2));
    qsort(q, 5, sizeof *q, cmp_int);
    T("%d %d %d %d %d", q[0], q[1], q[2], q[3], q[4]);
    i = 0;
    v[i] = 5, i = 2, v[i] = 6;
    T("%d %d %d", v[0], v[2], i);
    i = 3;
    T("%d", i++ + 1);
    T("%d", i);
    T("%d", (i = 4, i * 2));

    memcpy(buf, "abcdefgh", 9);
    memmove(buf + 2, buf, 5);      /* overlap */
    T("%s", buf);
    memmove(buf, buf + 3, 4);
    T("%s", buf);
    T("%d %d", strcmp("abc", "abd") < 0, strncmp("abc", "abd", 2));
    T("%d", memcmp("\xff", "\x01", 1) > 0);
    T("%s", strchr("hello", 'l'));
    T("%s", strrchr("hello", 'l'));
    T("%s", strstr("haystack", "st"));
    T("%d", strchr("x", 'q') == NULL);
    T("%d", strchr("x", '\0') != NULL);
}

/* ---- control flow ------------------------------------------------------ */
static int fall(int x)
{
    int r = 0;

    switch (x) {
    case 1: r += 1; /* FALLTHROUGH */
    default: r += 10; /* FALLTHROUGH */
    case 2: r += 100; break;
    case 3: { int k = x * 2; r = k; } break;
    case -1: for (r = 0; r < 5; r++) { if (r == 2) break; } r += 50; break;
    case 4: while (1) { r++; if (r > 3) break; } if (r) break; r = 999;
    }
    return r;
}
static int gotos(int x)
{
    int i = 0, s = 0;

    if (x < 0) goto done;
again:
    for (i = 0; i < 3; i++) {
        if (i == x) goto out;
        s += i + 1;
    }
    if (x == 9 && s < 10) goto again;
out:
    s *= 2;
done:
    return s + i;
}
static int counter(void) { static int n = 10; return n++; }
static int side;
static int bump(int v) { side = side * 10 + v; return v; }

static void control(void)
{
    int i, j, k;

    for (i = -1; i < 6; i++) T("%d %d", i, fall(i));
    T("%d %d %d %d", gotos(-1), gotos(1), gotos(5), gotos(9));
    T("%d %d %d", counter(), counter(), 0);
    T("%d", counter());
    side = 0;
    k = bump(1) && bump(0) && bump(2);
    T("%d %d", k, side);
    side = 0;
    k = bump(0) || bump(3) || bump(4);
    T("%d %d", k, side);
    side = 0;
    k = bump(1) ? bump(5) : bump(6);
    T("%d %d", k, side);
    for (i = 0, j = 10; i < j; i += 3, j -= 2) ;
    T("%d %d", i, j);
    i = 0;
    do { if (++i == 2) continue; if (i > 3) break; } while (i < 10);
    T("%d", i);
    for (i = 0; i < 3; i++) {
        switch (i) { case 1: continue; default: break; }
        T("%d", i);
    }
    T("%d", 5 > 3 == 1);
    T("%d", 1 + 2 << 1);
    T("%d", 1 & 3 == 3);
    k = 5; k <<= 2; k %= 7; k ^= 1;
    T("%d", k);
    T("%d", sizeof(char) + sizeof(short) * 2);
    {
        int shadow = 1;
        { int shadow = 2; T("%d", shadow); }
        T("%d", shadow);
    }
    { struct inner pt = { .c = 2 }; T("%d %d", pt.s, pt.c); }
    { int a[4] = { [2] = 7 }; T("%d %d", a[1], a[2]); }
    T("%c", "abc"[1]);
    T("%d", 'A' + 1);
    T("%d", '\377');
    T("%d", '\n');
}

/* ---- libc formatting and parsing --------------------------------------- */
static void libc(void)
{
    char buf[64], w[16];
    int a = 0, b = 0, n = 0;
    char c = 0, *end;
    unsigned u = 0;
    long l;

    T("[%5d][%-5d][%05d][%+d][% d]", 42, 42, 42, 42, 42);
    T("[%x][%X][%o][%#x][%#o]", 255, 255, 8, 255, 8);
    T("[%5s][%-5s][%.2s][%5.1s]", "abc", "abc", "abc", "abc");
    T("[%c][%3c][%-3c]", 'x', 'y', 'z');
    T("[%*d][%-*d][%.*s]", 4, 7, 4, 7, 2, "hello");
    T("[%ld][%lu][%lld][%hd][%hhd]", -1L, 1UL, -1LL, (short) 70000, (signed char) 300);
    T("[%%]%s", "");
    n = sprintf(buf, "%s-%d", "ab", 12);
    T("%d %s", n, buf);
    n = snprintf(buf, 4, "%s", "abcdef");
    T("%d %s", n, buf);
    n = sscanf("12 34", "%d %d", &a, &b);
    T("%d %d %d", n, a, b);
    n = sscanf("7:x", "%u:%c", &u, &c);
    T("%d %u %c", n, u, c);
    n = sscanf("  word rest", "%15s", w);
    T("%d %s", n, w);
    n = sscanf("abc", "%d", &a);
    T("%d", n);
    n = sscanf("", "%d", &a);
    T("%d", n);
    n = sscanf("0x1f 077", "%i %i", &a, &b);
    T("%d %d %d", n, a, b);
    n = sscanf("12abc", "%d%n", &a, &b);
    T("%d %d %d", n, a, b);
    n = sscanf("abc,def", "%[^,],%s", buf, w);
    T("%d %s %s", n, buf, w);
    T("%d %d %d %d", atoi("12x"), atoi("  -5"), atoi("x"), atoi("+7"));
    l = strtol("0x10z", &end, 16);
    T("%ld %s", l, end);
    l = strtol("777", &end, 8);
    T("%ld %s", l, end);
    l = strtol("zz", &end, 10);
    T("%ld %s", l, end);
    T("%d %d", abs(-3), abs(3));
}

int main(void)
{
    promotions();
    arith();
    floats();
    structs();
    pointers();
    control();
    libc();
    return 0;
}
