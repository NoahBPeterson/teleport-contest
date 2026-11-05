#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){int r=0,i;for(i=0;i<3;i++){switch(i){case 0:{int a[2]={1,2};r+=a[1];break;}case 1:;int b[2]={3,4};r+=b[0];break;default:r+=100;}}printf("%d\n",r);return 0;}
