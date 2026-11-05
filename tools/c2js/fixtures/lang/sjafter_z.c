#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <setjmp.h>
static jmp_buf j;int main(void){int n=0;if(setjmp(j)){n+=10;printf("back %d\n",n);if(n>=20)return 0;}n++;longjmp(j,1);return 0;}
