#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static int g[3]={1,2,3};static int *get(int i){return &g[i];}static int (*row(void))[3]{return &g;}static char *buf(void){static char b[4]="abc";return b;}int main(void){*get(1)=9;printf("%d %d %s %c\n",g[1],(*row())[2],buf(),*buf());return 0;}
