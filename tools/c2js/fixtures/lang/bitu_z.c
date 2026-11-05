#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
union U{unsigned a:3;unsigned char b;};struct R{unsigned a:3;unsigned :2;unsigned c:3;int d;};int main(void){union U u;struct R r;u.b=0xFF;r.a=5;r.c=2;r.d=1;printf("%d %d %d %d\n",u.a,r.a,r.c,(int)sizeof(struct R));return 0;}
