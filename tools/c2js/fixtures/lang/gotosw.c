#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static int f(int x){int r=0;switch(x){case 1:r=1;goto out;case 2:{int a[2]={4,5};r=a[1];goto dn;}default:r=9;}r+=1;dn:r+=2;out:return r;}int main(void){printf("%d %d %d\n",f(1),f(2),f(3));return 0;}
