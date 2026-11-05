#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){int v[3]={1,2,3};printf("%d %c\n",1[v],1["abc"]);2[v]=9;printf("%d\n",v[2]);return 0;}
