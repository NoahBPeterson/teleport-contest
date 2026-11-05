#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int a=1,b=2;int *p=(a?&a:&b);*p=3;printf("%d\n",a);return 0;}
