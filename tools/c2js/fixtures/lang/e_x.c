#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=3;int *t[2][2]={{&x,0},{0,&x}};*t[1][1]=4;printf("%d\n",x);return 0;}
