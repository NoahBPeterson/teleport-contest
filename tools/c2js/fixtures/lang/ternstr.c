#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){int a=1;struct P{int x;}p={1},q={2};struct P r=a?q:p;char *s=a?"yes":"no";short t=a?(short)-1:0;long l=a?-1:0L;unsigned u=a?-1:0U;printf("%d %s %d %ld %u %d\n",r.x,s,t,l,u,(a,3));return 0;}
