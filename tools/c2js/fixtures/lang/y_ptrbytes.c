#include <stdio.h>
#include <string.h>
struct n{int v;struct n *next;}; int main(void){ int x=5; int *p=&x,*q=0; memcpy(&q,&p,sizeof p); *q=6; char b[8]; *(int**)b=&x; int *r=*(int**)b; *r+=1; struct n a={1,0},c={2,&a},d; memcpy(&d,&c,sizeof c); int y[2]={3,4}; int *ya[1]={y+1}; int *z; memcpy(&z,ya,8); struct n e=c; printf("%d %d %d %d %d\n",x,d.next->v,*z,e.next==&a,d.next==&a); return 0; }