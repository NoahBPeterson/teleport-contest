#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
struct P{int x;char n[4];};static struct P mk(int v){struct P p;p.x=v;strcpy(p.n,"ab");return p;}static int g(struct P p){p.x++;return p.x;}int main(void){struct P a=mk(1),b;b=a;b.n[0]=90;printf("%d %d %s %s %d\n",a.x,g(a),a.n,b.n,mk(5).x);return 0;}
