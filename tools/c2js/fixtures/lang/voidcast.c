#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static int g;static int f(void){return ++g;}int main(void){(void)f();(void)0;f(),f();if(f(),g>3)g=10;for(f();g<12;f());printf("%d\n",g);return 0;}
