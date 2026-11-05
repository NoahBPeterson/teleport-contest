#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=1;int *p=&x;static int *sp;sp=p;*sp=2;printf("%d\n",x);return 0;}
