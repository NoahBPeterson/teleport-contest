#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){_Bool b=5;_Bool c=0.5;_Bool d=(_Bool)256;int i=b+1;b++;b--;unsigned char u=256;signed char s=200;printf("%d %d %d %d %d %d %d\n",b,c,d,i,u,s,!b);return 0;}
