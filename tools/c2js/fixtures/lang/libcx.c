#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <ctype.h>
static int ci(const void *a,const void *b){return *(const int*)a-*(const int*)b;}
int main(void){char s[20]="a,b;c";char *t;int k[4]={1,3,5,7};int key=5;int *f=bsearch(&key,k,4,sizeof(int),ci);char *e;double d=strtod("3.5xy",&e);char *dd=strdup("dup");srand(7);printf("%d %d %d\n",rand(),rand(),rand());srand(1);printf("%d\n",rand());for(t=strtok(s,",;");t;t=strtok(0,",;"))printf("[%s]",t);printf(" %d %.1f %s %s %zu %lld %lld %d %d\n",*f,d,e,dd,strnlen("abcdef",3),strtoll("-12x",&e,10),llabs(-9LL),!!isxdigit(70),!!isgraph(32));printf("%.3f %.3f %.3f %.1f %.1f\n",sin(1.0),atan2(1.0,2.0),log10(100.0),round(2.5),round(-2.5));strncat(s,"zzz",2);printf("%s\n",s);return 0;}
