#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){int a[4]={1,2,3,4};int *p=a+1,*q=a+3;long d=q-p;char *c=(char*)a;printf("%ld %d %d %d %d %d\n",d,p<q,*(q-1),(int)((char*)q-c),c[4],(int)(a+4==q+1));return 0;}
