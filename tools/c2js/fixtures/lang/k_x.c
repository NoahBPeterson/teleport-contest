#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int g=1;int main(void){int *p=&g;int **q=&p;**q=5;printf("%d\n",g);return 0;}
