#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int g[2][3]={{1,2,3},{4,5,6}};int main(void){int *p=&g[0][0];printf("%d\n",p[4]);return 0;}
