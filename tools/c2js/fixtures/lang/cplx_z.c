#define _FORTIFY_SOURCE 0
#include <stdio.h>
struct S { char c; _Complex double z; _Complex float f; };
int main(void) {
    _Complex double a = 1.0 + 2.0 * 1.0i, b = 3.0 - 1.0i, c;
    _Complex float g = 1.5f + 0.5fi;
    struct S s = { 'x', 2.0 + 1.0i, 0.25f };
    c = a * b;
    printf("%.1f %.1f\n", __real__ c, __imag__ c);
    c = a / b; printf("%.4f %.4f\n", __real__ c, __imag__ c);
    c = -a + ~b; printf("%.1f %.1f\n", __real__ c, __imag__ c);
    c += 2; c *= a; printf("%.1f %.1f %d %d\n", __real__ c, __imag__ c, a == b, a != b);
    s.z *= 2.0; s.f += g; printf("%.2f %.2f %.2f %.2f %d %d\n", __real__ s.z, __imag__ s.z, (double) __real__ s.f, (double) __imag__ s.f, (int) sizeof s, (int) sizeof g);
    printf("%d %.1f\n", !a, (double) a);
    if (a) printf("nonzero\n");
    return 0;
}
