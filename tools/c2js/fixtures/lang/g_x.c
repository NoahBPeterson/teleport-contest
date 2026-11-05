#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int m[2][3]={{1,2,3},{4,5,6}};int (*r)[3]=m;r++;printf("%d %d\n",r[0][1],(*r)[2]);return 0;}
