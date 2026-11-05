#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
struct O{int (*f)(int);const char *n;int k[2];};static int a(int x){return x+1;}static int b(int x){return x*2;}static struct O t[2]={{a,"a",{1,2}},{b,"b",{3,4}}};int main(void){struct O l=t[1];struct O *p=&t[0];int (*g)(int)=p->f;printf("%d %d %s %d %d\n",l.f(3),g(3),l.n,l.k[1],(*p->f)(1));return 0;}
