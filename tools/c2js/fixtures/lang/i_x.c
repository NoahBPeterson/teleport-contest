#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int m[2][3]={{1,2,3},{4,5,6}};int *p=&m[1][2];*p=9;printf("%d\n",m[1][2]);return 0;}
