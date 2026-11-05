#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=3;int *pp[2]={&x,&x};int **a[2]={&pp[0],&pp[1]};**a[1]=8;printf("%d\n",x);return 0;}
