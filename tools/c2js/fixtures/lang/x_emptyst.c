#include <stdio.h>
struct e{}; struct z{int n;int a[0];}; int main(void){ struct e x; struct e y=x; (void)y; printf("%zu %zu\n",sizeof(struct e),sizeof(struct z)); return 0; }