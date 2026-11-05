#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
typedef int(*op)(int);static int a(int x){return x+1;}static int b(int x){return x*2;}static op t[2]={a,b};static op pick(int k){return t[k];}static int ap(op f,int v){return f(v);}int main(void){int (*(*pp)[2])(int)=&t;printf("%d %d %d\n",pick(1)(4),ap(a,4),(*pp)[1](5));return 0;}
