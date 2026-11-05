#include <stdio.h>
enum e{A,B=4}; int main(void){ enum e a[2]={B,A}; enum e *p=a; p[1]=B; printf("%d %d %zu\n",a[0],a[1],sizeof a); return 0; }