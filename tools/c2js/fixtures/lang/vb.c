#include <stdio.h>
int main(void){ int n=2; int a[n][n]; a[1][0]=7; int (*p)[n]=a; n=5; printf("%d %zu\n",p[1][0],sizeof a); return 0; }
