#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int x=1,y=2;int *a[2]={&x,&y};*a[1]=7;printf("%d %d\n",*a[0],y);return 0;}
