#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
struct E{int k;char n[4];};static int cmp(const void *a,const void *b){return ((const struct E*)a)->k-((const struct E*)b)->k;}int main(void){struct E e[3]={{3,"c"},{1,"a"},{2,"b"}};qsort(e,3,sizeof e[0],cmp);printf("%s %s %s\n",e[0].n,e[1].n,e[2].n);return 0;}
