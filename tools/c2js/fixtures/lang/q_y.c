#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=1;int *const p=&x;int *const *q=&p;**q=2;printf("%d\n",x);return 0;}
