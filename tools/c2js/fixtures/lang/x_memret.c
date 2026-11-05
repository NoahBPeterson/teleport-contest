#include <stdio.h>
struct s{int a[2];int b;}; static struct s f(void){ struct s x={{1,2},3}; return x; } int main(void){ printf("%d %d\n",f().a[1],f().b); int v=f().a[0]; printf("%d\n",v); return 0; }