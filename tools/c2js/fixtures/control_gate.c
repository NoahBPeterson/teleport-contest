/* control_gate.c — c2js fixture: C int truth values and goto/break targets.
 *
 * Two emitter bugs, each found as a held-out-style RNG desync:
 *
 *  1. A boolean-valued `return` in an integer function (`return !x;`,
 *     `return a < b;`) was emitted as a JS boolean.  Arithmetic coerces it,
 *     strict equality does not: steal.c's `return !rn2(n)` reached uhitm.c's
 *     `switch (steal(...)) { case 0: ... }` as `false` and fell into default.
 *
 *  2. A switch-internal label region ending in `break` is spliced at each
 *     `goto`; spliced inside a loop, its `break` left the loop instead of the
 *     switch.  mkroom.c fill_zoo(): `goto throne_placed` from the nested
 *     throne scan ran on into the random-spot loop and made a second throne
 *     monster.
 *
 * Prints a trace; the transpiled JS must match byte-for-byte
 * (tools/c2js/test-control.mjs).
 */
#include <stdio.h>

typedef unsigned char boolean; /* as NetHack's global.h */

/* ---- 1. truth values returned from integer functions ------------------- */

static int not_of(int r) { return !r; }               /* steal(): return !rn2(n) */
static int less(int a, int b) { return a < b; }
static boolean bool_eq(int a, int b) { return a == b; } /* boolean is an int type */
static long lnot_of(long r) { return !r; }

static const char *classify(int v)
{
    switch (not_of(v)) {   /* mhitm_ad_sitm(): switch (steal(magr, buf)) */
    case -1:
        return "died";
    case 0:
        return "kept attacking";
    default:
        return "fled";
    }
}

static void part1(void)
{
    int i;

    for (i = 0; i < 4; i++)
        printf("not_of(%d) -> %s\n", i, classify(i));
    for (i = 0; i < 3; i++) {
        int r = less(i, 1);
        static const char *names[] = { "no", "yes" };

        switch (r) {
        case 1:  printf("less(%d,1): case 1 (%s)\n", i, names[r]); break;
        case 0:  printf("less(%d,1): case 0 (%s)\n", i, names[r]); break;
        default: printf("less(%d,1): default\n", i); break;
        }
    }
    printf("bool_eq(2,2) == 1: %d, bool_eq(2,3) == 0: %d\n",
           bool_eq(2, 2) == 1, bool_eq(2, 3) == 0);
    switch (lnot_of(0L)) {
    case 1:  printf("lnot_of(0): case 1\n"); break;
    default: printf("lnot_of(0): default\n"); break;
    }
}

/* ---- 2. goto out of nested loops to a label region ending in break ----- */

#define W 6
#define H 4
static int grid[W][H];
static int made;

static void make_at(int x, int y)
{
    made++;
    printf("  make_at(%d,%d) #%d\n", x, y, made);
}

/* fill_zoo()-shaped: kind 0 scans for a marked cell ("throne") and jumps
 * past the fallback search; kind 1 has no scan. */
static void fill(int kind, int maze)
{
    int tx = -1, ty = -1, i;

    switch (kind) {
    case 0:
        if (maze) {
            for (tx = 0; tx < W; tx++)
                for (ty = 0; ty < H; ty++)
                    if (grid[tx][ty] == 9)
                        goto placed;
        }
        i = 3;
        do { /* fallback spot search */
            tx = i;
            ty = i % H;
            printf("  fallback probe %d\n", i);
        } while (--i > 0 && grid[tx][ty] != 0);
 placed:
        make_at(tx, ty);
        break;
    case 1:
        printf("  kind 1\n");
        break;
    }
    printf("  after switch: tx=%d ty=%d\n", tx, ty);
}

/* the same, but the label region holds a loop of its own whose break must
 * stay the loop's */
static void fill_loop(void)
{
    int x, y, n = 0;

    switch (1) {
    case 1:
        for (x = 0; x < W; x++)
            for (y = 0; y < H; y++)
                if (grid[x][y] == 9)
                    goto found;
        printf("  not found\n");
 found:
        for (;;) {
            if (++n > 2)
                break; /* this break belongs to the for(;;) */
        }
        printf("  found, n=%d\n", n);
        break;
    }
    printf("  fill_loop done\n");
}

static void part2(void)
{
    grid[3][2] = 9;
    printf("fill(0, maze=1):\n");
    made = 0;
    fill(0, 1);
    printf("fill(0, maze=0):\n");
    made = 0;
    fill(0, 0);
    printf("fill(1, maze=1):\n");
    fill(1, 1);
    printf("fill_loop:\n");
    fill_loop();
}

int main(void)
{
    part1();
    part2();
    return 0;
}
