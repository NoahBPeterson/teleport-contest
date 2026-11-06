#include <stdio.h>
int main(void){ int c=getchar(); char b[8]; char *s=fgets(b,8,stdin); int x; int r=scanf("%d",&x); printf("%d %d %d %d\n",c,s==0,r,feof(stdin)!=0); return 0; }