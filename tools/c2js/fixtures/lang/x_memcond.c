#include <stdio.h>
struct s{int a;}; int main(void){ struct s x={1},y={2}; int c=1; printf("%d %d\n",(c?x:y).a,(c?&y:&x)->a); *(c?&x.a:&y.a)=9; printf("%d\n",x.a); return 0; }