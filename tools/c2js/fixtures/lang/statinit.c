#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
static int v=3;static int *pv=&v;static int a[2]={1,2};static int *pa=&a[1];static int *pb=a;static const char *s="hi";static char c[]="yo";static char *pc=c;static int (*pm)[2]=&a;static struct{int *p;int n;}st={&v,1};int main(void){printf("%d %d %d %s %s %s %d %d\n",*pv,*pa,*pb,s,c,pc,(*pm)[1],*st.p);return 0;}
