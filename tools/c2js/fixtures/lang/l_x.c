#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int m[2][2]={{1,2},{3,4}};m[1][0]|=8;m[1][1]+=1;printf("%d %d\n",m[1][0],m[1][1]);return 0;}
