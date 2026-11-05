#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int g=1;static int *gp=&g;int main(void){*gp=5;printf("%d\n",g);return 0;}
