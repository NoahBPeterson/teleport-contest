#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){int a[3]={1,2,3};int (*q)[3]=&a;printf("%d\n",(*q)[1]);return 0;}
