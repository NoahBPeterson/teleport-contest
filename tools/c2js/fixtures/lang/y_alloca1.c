#include <stdio.h>
#include <alloca.h>
int main(void){ int n=3; int *p=alloca(n*sizeof(int)); char *c=__builtin_alloca(4); p[2]=7; c[0]='q'; c[1]=0; printf("%d %s\n",p[2],c); return 0; }