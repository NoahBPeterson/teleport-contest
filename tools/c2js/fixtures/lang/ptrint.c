#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){int x=1;int *p=&x;uintptr_t u=(uintptr_t)p;int *q=(int*)u;*q=5;void *v=p;int *r=v;char *c=v;printf("%d %d %d\n",x,*r,c[0]);return 0;}
