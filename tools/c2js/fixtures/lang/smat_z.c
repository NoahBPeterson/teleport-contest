#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
struct C{int v[2][2];char t[2][3];};static struct C g={{{1,2},{3,4}},{"a","b"}};int main(void){struct C l=g;int *p=&l.v[0][0];l.v[1][0]=9;printf("%d %d %s %d\n",p[2],g.v[1][0],l.t[1],(int)sizeof g);return 0;}
