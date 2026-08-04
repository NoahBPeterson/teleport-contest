/* setjmp_gate.c — hard-construct gate A fixture: setjmp/longjmp shapes.
 *
 * Mirrors the real call sites:
 *  (a) nhlua.c:2281  `if (setjmp(nud->jb)) { panic(...) }` — bare condition
 *  (b) nested setjmp: inner handler catches, then longjmps to the outer
 *  (c) longjmp across several call frames (no handler in between)
 *  (d) Lua 5.4.8 ldo.c: LUAI_TRY / LUAI_THROW with struct lua_longjmp
 *      (jmp_buf member, errorJmp chaining, status set before throw) —
 *      see luaD_rawrunprotected (ldo.c:135) and luaD_throw (ldo.c:111)
 *  (e) assignment-then-test shape `if ((v = setjmp(jb)) != 0)` and the
 *      longjmp(jb, 0) -> setjmp returns 1 rule
 *
 * Prints a trace; the transpiled JS must produce the identical trace.
 * No NetHack headers — standalone (system setjmp.h/stdio.h only).
 */
#include <stdio.h>
#include <setjmp.h>

static jmp_buf jb_a;
static jmp_buf jb_outer;
static jmp_buf jb_inner;

/* ---- (a) bare if (setjmp) — the nhlua.c:2281 shape ---------------------- */

static int worker_a(int x)
{
    if (x < 0) {
        printf("a: worker longjmps on %d\n", x);
        longjmp(jb_a, 1);
    }
    return x * 10;
}

static void test_a(void)
{
    if (setjmp(jb_a)) {
        printf("a: recovered in handler\n");
        return;
    }
    printf("a: direct call %d\n", worker_a(5));
    printf("a: direct call %d\n", worker_a(-1));
    printf("a: unreachable\n");
}

/* ---- (b) nested setjmp: inner catches, rethrows to outer ----------------- */

static void inner_b(int mode)
{
    if (setjmp(jb_inner)) {
        printf("b: inner handler caught\n");
        longjmp(jb_outer, 3);
    }
    if (mode)
        longjmp(jb_inner, 2);
    printf("b: inner returns normally\n");
}

static void test_b(void)
{
    if (setjmp(jb_outer)) {
        printf("b: outer handler caught\n");
        return;
    }
    inner_b(0);
    inner_b(1);
    printf("b: unreachable\n");
}

/* ---- (c) longjmp across several frames ----------------------------------- */

static jmp_buf jb_c;

static void frame3(int v)
{
    printf("c: frame3 %d\n", v);
    longjmp(jb_c, v + 1);
}

static void frame2(int v)
{
    printf("c: frame2 %d\n", v);
    frame3(v + 1);
    printf("c: frame2 unreachable\n");
}

static void frame1(int v)
{
    printf("c: frame1 %d\n", v);
    frame2(v + 1);
    printf("c: frame1 unreachable\n");
}

static void test_c(void)
{
    int v;
    v = 0;
    if ((v = setjmp(jb_c)) != 0) {
        printf("c: caught value %d\n", v);
        return;
    }
    frame1(10);
    printf("c: unreachable\n");
}

/* ---- (d) Lua pattern: LUAI_TRY / LUAI_THROW ------------------------------ */

/* mirrors struct lua_longjmp (ldo.c:74) and luaconf.h's C-setjmp branch:
   #define LUAI_THROW(L,c) _longjmp((c)->b, 1)
   #define LUAI_TRY(L,c,a) if (_setjmp((c)->b) == 0) { a }              */
struct lua_longjmp {
    jmp_buf b;
    int status;
    struct lua_longjmp *previous;
};

static struct lua_longjmp *errorJmp = 0;

#define LUAI_THROW(c) longjmp((c)->b, 1)
#define LUAI_TRY(c, a) if (setjmp((c)->b) == 0) { a }

/* mirrors luaD_throw's "set status, then jump" (ldo.c:111) */
static void l_throw(int errcode)
{
    if (errorJmp) {
        errorJmp->status = errcode;
        LUAI_THROW(errorJmp);
    } else {
        printf("d: uncaught error %d\n", errcode);
    }
}

static int risky_d(int arg)
{
    printf("d: risky(%d)\n", arg);
    if (arg > 100)
        l_throw(arg);
    return arg * 2;
}

/* mirrors luaD_rawrunprotected (ldo.c:135) */
static int runprotected(int (*f)(int), int arg)
{
    struct lua_longjmp lj;
    int result = -1;
    lj.status = 0;
    lj.previous = errorJmp; /* chain new error handler */
    errorJmp = &lj;
    LUAI_TRY(&lj,
        result = f(arg);
    );
    errorJmp = lj.previous;
    printf("d: runprotected status %d result %d\n", lj.status, result);
    return lj.status;
}

static void test_d(void)
{
    runprotected(risky_d, 21);   /* ok */
    runprotected(risky_d, 300);  /* throws */
    runprotected(risky_d, 7);    /* ok again — chain restored */
    l_throw(99);                 /* no handler: falls to the else branch */
}

/* ---- (e) longjmp(jb, 0) yields 1 ----------------------------------------- */

static jmp_buf jb_e;

static void test_e(void)
{
    int v;
    if ((v = setjmp(jb_e)) != 0) {
        printf("e: setjmp returned %d after longjmp(jb, 0)\n", v);
        return;
    }
    longjmp(jb_e, 0);
}

int
main(void)
{
    test_a();
    test_b();
    test_c();
    test_d();
    test_e();
    printf("done\n");
    return 0;
}
