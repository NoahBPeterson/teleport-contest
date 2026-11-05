#include <stdio.h>
#include <stdlib.h>
int main(void){ div_t d=div(-7,2); printf("%d %d\n",d.quot,d.rem);
 ldiv_t l=ldiv(-70000000000L,3); printf("%ld %ld\n",l.quot,l.rem);
 lldiv_t q=lldiv(1000000000000LL,7); printf("%lld %lld\n",q.quot,q.rem);
 printf("%d\n",div(9,4).rem);
 int x; int *n=0; printf("%p %s\n",(void*)n,&x?"nz":"z"); return 0; }
