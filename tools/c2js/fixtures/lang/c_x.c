#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=1,y=2;int *p=&x;int **q=&p;*q=&y;*p=9;printf("%d %d\n",x,y);return 0;}
