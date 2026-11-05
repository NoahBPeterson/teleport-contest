#include <stdio.h>
struct s{int n;int a[];}; static struct s g={2,{7,8}}; int main(void){ printf("%d %d %zu\n",g.a[1],g.n,sizeof g); return 0; }