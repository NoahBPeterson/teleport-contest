#include <stdio.h>
int f(a,b) int a; char *b; { return a+b[0]; } int main(void){ printf("%d\n",f(1,"A")); return 0; }