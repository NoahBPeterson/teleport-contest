#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
static int f(int x){int i=0;if(x)goto mid;while(i<5){i+=2;mid:i++;}return i;}int main(void){int i=0;back:i++;if(i<3)goto back;printf("%d %d %d\n",i,f(0),f(1));return 0;}
