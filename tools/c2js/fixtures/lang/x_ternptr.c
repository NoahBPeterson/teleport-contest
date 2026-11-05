#include <stdio.h>
int main(void){ int a=1,b=2; int *p=a?&a:&b; void *v=a?(void*)p:0; const char *s=a?"y":"n"; int *n=b>5?&a:0; printf("%d %s %d %d\n",*p,s,n==0,v==p); return 0; }