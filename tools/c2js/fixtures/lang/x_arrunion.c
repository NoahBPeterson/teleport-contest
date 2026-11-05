#include <stdio.h>
union u{int i;char c[4];}; int main(void){ union u a[2]; a[1].i=0x01020304; printf("%d %zu\n",a[1].c[1],sizeof a); return 0; }