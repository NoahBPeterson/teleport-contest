#include <stdio.h>
int f(); int f(a) int a; { return a*2; } int (*fp)()=f; double d1(double x){ return x/2; } int main(void){ printf("%d %d %f\n",f(2),fp(3),(double)d1(3)); return 0; }