#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){long double d=1.5L;d*=2;printf("%.2Lf %d\n",d,(int)d);return 0;}
