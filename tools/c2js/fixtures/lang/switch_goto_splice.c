/* A goto out of nested loops to a label inside a switch, whose tail ends in
 * break. The spliced copy must leave the switch, not the inner loop. Regression:
 * looking the goto plan up on a copied switch body lost the labeled break, so
 * mkroom.c fill_zoo() made a second throne monster on maze-level courts. */
#include <stdio.h>

static int calls;
static void hit(int x, int y) { calls++; printf("hit %d %d\n", x, y); }

static int plain(int k) {
    int x = 0, y = 0;
    switch (k) {
    case 1:
        for (x = 0; x < 3; x++)
            for (y = 0; y < 3; y++)
                if (x == 1 && y == 1)
                    goto placed;
        x = 7;
        y = 7;
    placed:
        hit(x, y);
        break;
    case 2:
        hit(-1, -1);
        break;
    default:
        hit(-2, -2);
    }
    return x * 10 + y;
}

/* The same, with a declaration before the first case. */
static int with_decl(int k) {
    int x = 0, y = 0;
    switch (k) {
        int unused;
    case 1:
        unused = 4;
        for (x = 0; x < 3; x++)
            for (y = 0; y < 3; y++)
                if (x == 2 && y == unused - 3)
                    goto placed;
        x = 8;
        y = 8;
    placed:
        hit(x, y);
        break;
    default:
        hit(-3, -3);
    }
    return x * 10 + y;
}

/* A second label in the same switch, and one reached by falling through. */
static int two_labels(int k, int want) {
    int r = 0, i;
    switch (k) {
    case 0:
        for (i = 0; i < 5; i++)
            if (i == want)
                goto a;
        r = 100;
        goto b;
    a:
        r += 1;
        hit(r, i);
        break;
    case 1:
        while (r < 10) {
            r++;
            if (r == want)
                goto b;
        }
        r = 200;
    b:
        r += 2;
        hit(r, want);
        break;
    }
    return r;
}

int main(void) {
    int k, w;
    for (k = 0; k < 4; k++) printf("plain %d = %d\n", k, plain(k));
    for (k = 0; k < 3; k++) printf("decl %d = %d\n", k, with_decl(k));
    for (k = 0; k < 2; k++)
        for (w = 0; w < 12; w += 3)
            printf("two %d %d = %d\n", k, w, two_labels(k, w));
    printf("calls %d\n", calls);
    return 0;
}
