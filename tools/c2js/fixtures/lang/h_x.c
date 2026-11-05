#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int m[2][3]={{1,2,3},{4,5,6}};int *p=&m[0][0];printf("%d\n",p[4]);return 0;}
