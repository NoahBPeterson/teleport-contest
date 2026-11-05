#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=3;int *p=&x;int **t[2][2]={{&p,0},{0,&p}};**t[1][1]=6;printf("%d\n",x);return 0;}
