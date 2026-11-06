#include <stdio.h>
static int f(int a[static 2],const int * restrict p,int b[const 1]){ return a[1]+*p+b[0]; } int main(void){ int v[2]={1,2}; printf("%d\n",f(v,v,v)); return 0; }