#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){int i=0;char c=0;printf("%d %d\n",_Generic(i,int:1,default:2),_Generic(c,int:1,default:2));return 0;}
