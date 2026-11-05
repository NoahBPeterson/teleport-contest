#include <stdio.h>
int main(void){ int x=1; int y=({ int t=x; t+=2; t; }); int *p=({ &x; }); *p=9; printf("%d %d\n",y,x); return 0; }