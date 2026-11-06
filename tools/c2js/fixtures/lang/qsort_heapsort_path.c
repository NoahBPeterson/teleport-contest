#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int key(const void*p){int v;memcpy(&v,p,4);return v;}
static int cmp(const void*a,const void*b){int ka=key(a)>>16,kb=key(b)>>16;printf("%d,%d\n",key(a)&0xffff,key(b)&0xffff);return ka<kb?-1:ka>kb?1:0;}
int main(void){int a[31];for(int i=0;i<31;i++){int k=i==30?0:i+1;a[i]=(k<<16)|i;}qsort(a,31,4,cmp);for(int i=0;i<31;i++)printf("%d ",a[i]&0xffff);printf("\n");return 0;}
