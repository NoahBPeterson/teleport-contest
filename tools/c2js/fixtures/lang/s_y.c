#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int g[3]={1,2,3};static int *t[2]={&g[1],&g[2]};int main(void){*t[0]=9;printf("%d\n",g[1]);return 0;}
