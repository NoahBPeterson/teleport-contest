/* Record libc qsort's exact comparator call sequence and final order.
 * Input (stdin): T test cases; each: n, then n ints (keys), then a "mode"
 * (0 = consistent compare by key; 1 = inconsistent: decided by a fixed
 * pseudo-random table indexed by (a, 7b+a) -> {-1,0,1}, asymmetric by design).
 * Output: per case, the list of (a,b) element-id pairs compared, then the
 * final id order. Elements are {id, key} structs (8 bytes). */
#include <stdio.h>
#include <stdlib.h>
typedef struct { int id, key; } E;
static int mode, tbl[64][64];
static int cmp(const void *pa, const void *pb) {
    const E *a = pa, *b = pb;
    printf("c %d %d\n", a->id, b->id);
    if (mode == 0) return (a->key > b->key) - (a->key < b->key);
    return tbl[a->id & 63][(b->id * 7 + a->id) & 63];
}
int main(void) {
    int T; if (scanf("%d", &T) != 1) return 1;
    unsigned s = 12345;
    for (int i = 0; i < 64; i++) for (int j = 0; j < 64; j++) { s = s * 1103515245u + 12345u; tbl[i][j] = (int)((s >> 16) % 3) - 1; }
    while (T--) {
        int n; scanf("%d", &n); E *v = malloc(sizeof(E) * (n ? n : 1));
        for (int i = 0; i < n; i++) { v[i].id = i; scanf("%d", &v[i].key); }
        scanf("%d", &mode);
        printf("case %d\n", n);
        qsort(v, n, sizeof(E), cmp);
        printf("o"); for (int i = 0; i < n; i++) printf(" %d", v[i].id); printf("\n");
        free(v);
    }
    return 0;
}
