#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
static int f(int n){int a[n];int i,s=0;for(i=0;i<n;i++)a[i]=i*2;for(i=0;i<n;i++)s+=a[i];return s+(int)sizeof a;}int main(void){printf("%d\n",f(4));return 0;}
