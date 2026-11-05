#define _FORTIFY_SOURCE 0
#include <stdio.h>
typedef unsigned char myc;typedef short my16;typedef myc *myp;typedef struct P{int x;}PP;typedef int arr3[3];int main(void){myc a[2]={255,1};my16 b[2]={-1,2};myp q=a;PP s[2]={{1},{2}};arr3 m={1,2,3};arr3 *r=&m;printf("%d %d %d %d %d %d\n",a[0],b[0],q[1],s[1].x,(*r)[2],(int)sizeof m);return 0;}
