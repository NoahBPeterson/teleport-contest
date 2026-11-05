#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
#include <setjmp.h>
static jmp_buf j;static void th(int v){longjmp(j,v);}int main(void){int r=setjmp(j);printf("%d\n",r);if(r<2)th(r+1);{int q=0;switch(setjmp(j)){case 0:q=1;break;default:q=2;}printf("%d\n",q);}return 0;}
