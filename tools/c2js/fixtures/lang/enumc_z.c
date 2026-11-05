#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
enum E{A=-1,B,C=5,D};static enum E g=D;int main(void){enum E e=C;e=(enum E)(e+1);printf("%d %d %d %d\n",A,B,e,g==D);return 0;}
