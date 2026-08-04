/* union_gate.c — hard-construct gate B fixture: unions on the CPtr model.
 *
 * Mirrors the real ones:
 *  - Lua 5.4.8 lobject.h:49  union Value { gc, p, f, i, n, ub } and
 *    struct TValue (TValuefields: Value value_ + lu_byte tt_) — the final
 *    exam of the union census (2,797 union member accesses in Lua).
 *  - NetHack hack.h:93  union str_or_len { char *str; int len }
 *    (Str_or_Len, used by the artifact/level-code tables).
 *  - a byte-view union for raw punning checks.
 *
 * Covers: write-through-one-member-read-another (observable punning),
 * size = max member size, struct-with-union-member layout, address-of-member
 * aliasing, pointer member round-trip. Prints a trace; the transpiled JS
 * must match byte-for-byte.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* ---- Lua 5.4.8 lobject.h mirror ---------------------------------------- */
typedef long long lua_Integer;
typedef double lua_Number;
typedef unsigned char lu_byte;
typedef int (*lua_CFunction)(void *L);

typedef union Value {
    void *gc;          /* collectable objects */
    void *p;           /* light userdata */
    lua_CFunction f;   /* light C functions */
    lua_Integer i;     /* integer numbers */
    lua_Number n;      /* float numbers */
    lu_byte ub;        /* byte view */
} Value;

typedef struct TValue {
    Value value_;
    lu_byte tt_;
} TValue;

/* ---- NetHack hack.h:93 mirror ------------------------------------------- */
typedef union str_or_len {
    char *str;
    int len;
} Str_or_Len;

/* ---- raw byte-punning union ---------------------------------------------- */
union bytes_or_int {
    unsigned char b[8];
    long long i;
    int i32[2];
};

/* struct with a union at a nonzero offset */
struct tagged {
    int tag;
    union bytes_or_int u;
};

int
main(void)
{
    /* sizes: union size = max member size, aligned */
    printf("sizeof Value=%d TValue=%d Str_or_Len=%d bytes_or_int=%d tagged=%d\n",
           (int) sizeof(Value), (int) sizeof(TValue), (int) sizeof(Str_or_Len),
           (int) sizeof(union bytes_or_int), (int) sizeof(struct tagged));

    /* integer -> double punning (IEEE bits read as double) */
    {
        Value v;
        v.i = 0x3FF0000000000000LL;
        printf("pun i->n: %f\n", v.n);
        v.n = 1.5;
        printf("pun n->i: %lld\n", v.i);
        v.n = -2.5;
        printf("pun n->i bits: 0x%llx\n", (unsigned long long) v.i);
    }

    /* TValue: tag byte lives after the union, value readback */
    {
        TValue t;
        t.tt_ = 9;
        t.value_.i = 42;
        printf("tvalue: tt=%d i=%lld\n", (int) t.tt_, t.value_.i);
        t.value_.n = 2.5;
        printf("tvalue punned: tt=%d n=%f\n", (int) t.tt_, t.value_.n);
    }

    /* byte view over an integer (little-endian) */
    {
        union bytes_or_int u;
        int k;
        u.i = 0x0102030405060708LL;
        printf("bytes:");
        for (k = 0; k < 8; k++)
            printf(" %d", (int) u.b[k]);
        printf("\n");
        u.b[3] = 0xFF;
        printf("after b[3]=0xFF: i=0x%llx\n", (unsigned long long) u.i);
        u.i32[1] = -1;
        printf("after i32[1]=-1: i=0x%llx\n", (unsigned long long) u.i);
    }

    /* struct with union at nonzero offset */
    {
        struct tagged tg;
        tg.tag = 7;
        tg.u.i = 0x1122334455667788LL;
        printf("tagged: tag=%d u.b0=%d u.i=0x%llx\n", tg.tag, (int) tg.u.b[0],
               (unsigned long long) tg.u.i);
    }

    /* address-of-member aliasing: all members share offset 0 */
    {
        union bytes_or_int u;
        long long *pi = &u.i;
        printf("alias: &i==&b[0] %d\n", (int) ((void *) &u.i == (void *) &u.b[0]));
        *pi = 5;
        printf("alias store: b0=%d b7=%d\n", (int) u.b[0], (int) u.b[7]);
    }

    /* NetHack str_or_len: pointer member and int member round-trips */
    {
        Str_or_Len sl;
        static char word[8];
        strcpy(word, "word");
        sl.len = 1234;
        printf("str_or_len len=%d\n", sl.len);
        sl.str = word;
        printf("str_or_len str=%s\n", sl.str);
        printf("str_or_len alias: %d\n", (int) ((void *) &sl.str == (void *) &sl.len));
    }

    /* pointer member round-trip through the union */
    {
        Value v1, v2;
        static char data[4];
        v1.p = data;
        v2 = v1; /* union assignment copies the bytes */
        printf("ptr roundtrip: %d\n", (int) (v2.p == v1.p));
        printf("fnptr member: %d\n", (int) (v1.f == 0));
    }

    printf("done\n");
    return 0;
}
