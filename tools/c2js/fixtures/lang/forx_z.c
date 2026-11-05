#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){int i=0,s=0;for(;;){if(++i>3)break;s+=i;}for(i=0;i<2;)i++;for(int k=0,m=1;k<2;k++,m*=2)s+=m;printf("%d\n",s);return 0;}
