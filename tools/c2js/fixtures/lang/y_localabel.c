#include <stdio.h>
int main(void){ int t=0; { __label__ a; goto a; t=9; a: t++; } { __label__ a; a: t++; if(t<4) goto a; } printf("%d\n",t); return 0; }