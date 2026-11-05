#include <stdio.h>
int a1(int x){return x+1;} int main(void){ int (*t[2][2])(int)={{a1,a1},{0,a1}}; printf("%d %d\n",t[1][1](1),t[1][0]==0); return 0; }