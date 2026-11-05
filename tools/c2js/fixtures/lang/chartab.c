#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static const unsigned char t[]={200,100};static const signed char st[]={-1,127};static const char *const names[]={"a","b"};static short sh[3]={-5};static long lg[]={-1L,1L<<40};static unsigned long ul[]={~0UL};static float fl[]={1.5f};static double db[]={2.5};static _Bool bo[2]={1};int main(void){printf("%d %d %s %d %ld %lu %.1f %.1f %d %d\n",t[0],st[0],names[1],sh[0],lg[1],ul[0],fl[0],db[0],bo[0],(int)sizeof bo);return 0;}
