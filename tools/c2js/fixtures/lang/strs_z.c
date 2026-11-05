#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){char a[2][4]={"ab","cd"};char b[]="hi";const char *s="x" "y";char (*r)[4]=a;printf("%s %s %s %s %s %zu\n",a[1],b,s,r[0],*(r+1),sizeof a);return 0;}
