#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static int f(int n){int i=0;again:{int a[3]={i,i+1,i+2};char s[4]="abc";i+=a[2]+(s[1]-97);}if(i<n)goto again;return i;}int main(void){printf("%d\n",f(9));return 0;}
