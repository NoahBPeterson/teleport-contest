#include <stdio.h>
union u{int *p;long l;char c[8];double d;}; int main(void){ int x=3; union u v; v.p=&x; union u w=v; *w.p=4; long l=v.l; int *back=(int*)l; printf("%d %d\n",x,*back); return 0; }