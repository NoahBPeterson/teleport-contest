#include <stdio.h>
static unsigned long long st=88172645463325252ULL;
int main(void){ st^=st<<13; printf("%llu\n",st); st^=st>>7; printf("%llu\n",st); st^=st<<17; printf("%llu\n",st); printf("%llu\n",st>>11); double d=(double)(st>>11); printf("%.17g\n",d); printf("%.17g\n",d/9007199254740992.0); union{double d;unsigned long long u;}x; x.d=1.5; printf("%llx\n",x.u); return 0; }
