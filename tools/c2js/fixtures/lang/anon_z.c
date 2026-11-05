#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){struct {int x,y;} pt={.y=2};union {int i;char c[4];} u;u.i=0x01020304;printf("%d %d %d\n",pt.x,pt.y,u.c[0]);return 0;}
