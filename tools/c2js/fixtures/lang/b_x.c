#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=1;int *p=&x;int **q=&p;**q=5;printf("%d\n",x);return 0;}
