#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
static int s(int n,...){va_list a;int t=0,i;va_start(a,n);for(i=0;i<n;i++)t+=va_arg(a,int);va_end(a);return t;}static long l(int n,...){va_list a;long t=0;va_start(a,n);t=va_arg(a,long)+(long)va_arg(a,double);va_end(a);return t;}int main(void){printf("%d %ld\n",s(3,1,2,3),l(2,4L,2.5));return 0;}
