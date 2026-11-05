#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int g=0;static int f(void){int *p=&g;(*p)++;return *p;}int main(void){f();printf("%d\n",g);return 0;}
