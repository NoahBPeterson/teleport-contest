#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
struct L{int v;struct L *n;};int main(void){struct L *h=0;int i,s=0;for(i=0;i<3;i++){struct L *x=malloc(sizeof *x);x->v=i;x->n=h;h=x;}for(;h;){struct L *t=h->n;s=s*10+h->v;free(h);h=t;}int *a=calloc(3,sizeof(int));a=realloc(a,5*sizeof(int));a[4]=8;printf("%d %d %d\n",s,a[0],a[4]);free(a);return 0;}
