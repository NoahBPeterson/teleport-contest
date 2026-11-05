#include <stdio.h>
#include <stdatomic.h>
static int more(void); static int g=5; static long long gl=9;
int main(void){ int x=3; int *p=&x; int *e=p+1; int *z=p+0; int *b=e-1;
 printf("%d %d %d %d %d %d\n",*z,*b,e==p+1,e>p,(int)(e-p),p[0]);
 for(int *i=p;i<p+1;i++) printf("%d\n",*i);
 int *pg=&g; printf("%d %d\n",*(pg+0),pg[0]); long long *pl=&gl; printf("%lld %d\n",pl[0],pl+1>pl);
 p++; p--; printf("%d %d\n",*p,p==&x);
 atomic_int ai=1; atomic_fetch_add(&ai,4); int old=atomic_exchange(&ai,9); atomic_store(&ai,atomic_load(&ai)+1); printf("%d %d\n",old,(int)ai);
 more(); return 0; }
static int more(void){ atomic_llong l=5; long long o=atomic_fetch_sub(&l,2); atomic_fetch_or(&l,8); atomic_fetch_xor(&l,1); atomic_fetch_and(&l,14); int a[2]={1,2}; int exp=9; atomic_int t; atomic_init(&t,1); int r1=atomic_compare_exchange_strong(&t,&exp,5); int v1=t; exp=1; int r2=atomic_compare_exchange_weak(&t,&exp,6); _Atomic(unsigned char) c=250; atomic_fetch_add(&c,10); printf("%lld %lld %d %d %d %d %d %d\n",o,(long long)l,r1,exp,v1,r2,(int)t,(int)c); return a[0]; }
