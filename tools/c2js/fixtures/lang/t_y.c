#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int f(int **q){**q=4;return 1;}int main(void){int x=1;int *p=&x;f(&p);printf("%d\n",x);return 0;}
