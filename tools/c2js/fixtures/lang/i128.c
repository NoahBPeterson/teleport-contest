#include <stdio.h>
int main(void){
 unsigned __int128 ub=~(unsigned __int128)0; printf("%llu %d\n",(unsigned long long)(ub>>64),(int)(ub%7));
__int128 a=-5; a*=3; __int128 b=a/2; __int128 arr[2]={a,b}; __int128 *p=arr; p++; struct { char c; __int128 v; } s={1,7}; printf("%d %d %d %zu %d\n",(int)a,(int)b,(int)*p,sizeof s,(int)(s.v<<3)); unsigned long long hi=(unsigned long long)(((unsigned __int128)0xFFFFFFFFFFFFFFFFULL*0xFFFFFFFFFFFFFFFFULL)>>64); printf("%llu\n",hi);
extern int more(void); more(); return 0; }
static __int128 gi=-3; static unsigned __int128 gu[2]={1,2}; __uint128_t mulu(unsigned long long a,unsigned long long b){ return (__uint128_t)a*b; }
static __int128 neg(__int128 v){ __int128 *p=&v; *p=-*p; *p+=1; (*p)++; return v; }
int more(void){ printf("%d %d %llu %d %d %d\n",(int)neg(gi),(int)gu[1],(unsigned long long)(mulu(1ULL<<40,1ULL<<40)>>64),(int)~gi,gi<0,(int)(gu[0]<<100>>99)); union { __int128 v; unsigned char b[16]; } u; u.v=-2; printf("%d %d %zu\n",u.b[0],u.b[15],_Alignof(__int128)); double d=(double)gi; __int128 fd=(__int128)2.5; printf("%f %d\n",d,(int)fd); return 0; }
