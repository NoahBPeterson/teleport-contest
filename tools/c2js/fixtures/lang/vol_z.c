#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
static volatile int g=1;int main(void){volatile int x=2;volatile int *p=&x;*p+=g;printf("%d\n",x);return 0;}
