#include <stdio.h>
struct s{int a,b;}; int main(void){ printf("%d %d\n",(struct s){1,2}.b,((int[]){3,4})[1]); struct s x; x=(struct s){.b=5}; printf("%d %d\n",x.a,x.b); return 0; }