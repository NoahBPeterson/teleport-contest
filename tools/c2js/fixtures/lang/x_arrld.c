#include <stdio.h>
int main(void){ long double a[2]={1.5L,2.5L}; long double *p=a+1; *p*=2; printf("%Lf %zu\n",a[1],sizeof a); return 0; }