#include <stdio.h>
struct s{int a,b;}; int main(void){ struct s x={1,2},y={3,4},z; printf("%d\n",(x=y).b); z=x=y; z.a=8; printf("%d %d\n",x.a,z.a); printf("%d\n",(0,y).a); return 0; }