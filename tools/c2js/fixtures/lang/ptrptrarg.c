#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static void set(char **out,const char *v){*out=(char*)v;}static void inc(int *p,int n){while(n--)(*p)++;}static void arr(int a[],int n){a[n-1]=9;}static int sum(int (*m)[2],int n){int s=0,i;for(i=0;i<n;i++)s+=m[i][1];return s;}int main(void){char *c=0;int x=0;int a[2]={1,2};int m[2][2]={{1,2},{3,4}};set(&c,"z");inc(&x,3);arr(a,2);printf("%s %d %d %d\n",c,x,a[1],sum(m,2));return 0;}
