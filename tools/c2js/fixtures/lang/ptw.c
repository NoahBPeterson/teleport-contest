#include <stdio.h>
#include <stdint.h>
#define T(ty,nm,init) static ty nm=init; static ty *p##nm=&nm; \
 static void t##nm(void){ ty loc=init; ty *q=&loc; ty **pp=&q; \
 long long a=(*p##nm = (ty)-3 + 70000); long long b=(*p##nm |= 0x12345); long long c=(*p##nm += 0x7FFFFFFF); long long d=(*p##nm)++; long long e=--(*p##nm); long long f=(*p##nm <<= 3); long long g2=(*p##nm >>= 1); long long h=(*p##nm ^= -1); long long i=(*p##nm *= 77777); long long j=(*p##nm /= 3); long long k=(*p##nm %= 11);\
 long long a2=(*q = (ty)-3 + 70000); long long b2=(**pp |= 0x12345); long long c2=(*q += 0x7FFFFFFF); long long d2=(*q)++; long long e2=--(**pp); long long f2=(loc <<= 3); long long h2=(loc ^= -1); long long i2=(**pp *= 77777); \
 long long z=(long long)(ty)((*p##nm)>0); printf(#ty ": %lld %lld %lld %lld %lld %lld %lld %lld %lld %lld %lld | %lld %lld %lld %lld %lld %lld %lld %lld | %lld %lld %lld\n",a,b,c,d,e,f,g2,h,i,j,k,a2,b2,c2,d2,e2,f2,h2,i2,z,(long long)nm,(long long)loc); }
T(int8_t,a8,5) T(uint8_t,b8,5) T(int16_t,a16,5) T(uint16_t,b16,5) T(int32_t,a32,5) T(uint32_t,b32,5) T(int64_t,a64,5) T(uint64_t,b64,5)
static int g1=1,g2=2; static int *gp=&g1; static int **gpp=&gp; static int ***gppp=&gpp;
static int *f(void){ gp=&g2; return gp; }
static int setp(void){ gp=&g2; return 9; }
int main(void){ ta8();tb8();ta16();tb16();ta32();tb32();ta64();tb64();
 int x=3,y=4; int *p=&x,*q=&y; int **pp=&p;
 printf("%d %d %d %d\n",p==q,p!=q,(*pp==&x),(p==&x)&&(q==&y));
 *pp=q; printf("%d %d\n",*p,p==q); **pp=7; printf("%d %d\n",x,y);
 printf("%d %d %d\n",**gpp,***gppp,gp==&g1);
 *gp=setp(); printf("%d %d %d\n",g1,g2,gp==&g2);
 gp=&g1; *f()=5; printf("%d %d\n",g1,g2);
 int *nul=(void*)0; printf("%d %d %d\n",nul==0,!nul,nul?1:0); printf("%d\n",(nul==(void*)0)+(p!=(void*)0));
 int *arrp[3]={&x,&y,0}; printf("%d %d\n",*arrp[0],arrp[2]==0);
 const int *cp=&x; volatile int vv=9; volatile int *vp=&vv; *vp+=1; printf("%d %d\n",*cp,vv);
 uint16_t u=0xFFFF; uint16_t *up=&u; printf("%d %d\n",(*up)+1,(*up+=1)); int8_t c8=127; int8_t *c8p=&c8; printf("%d %d %d\n",(*c8p)++,*c8p,(*c8p>0));
 int64_t big=-1; int64_t *bp=&big; uint32_t ww=7; uint32_t *wp=&ww; printf("%lld %u %d\n",*bp+*wp,*wp-8,(*bp<*wp));
 *wp=*bp; *bp=*wp; printf("%u %lld\n",ww,big);
 int t=5; int *tp=&t; int r=(*tp)+((*tp)=2); printf("%d\n",r>0);
 uint8_t uc=200; uint8_t *ucp=&uc; int sh=(*ucp<<1)+(*ucp>>1); printf("%d %d\n",sh,~*ucp);
 int *a=&x; int *b=a; b=(a!=b)?&y:a; printf("%d\n",b==a);
 printf("%d\n",&x==&x); printf("%d\n",&*p==p); printf("%d\n",*&*p);
 void *vs=&x; int *back=vs; printf("%d %d\n",back==&x,vs==(void*)&x);
 return 0; }
