#include <stdio.h>
#include <math.h>
static unsigned long long st=88172645463325252ULL; static double r(void){ st^=st<<13; st^=st>>7; st^=st<<17; return (double)(st>>11)/9007199254740992.0*20-10; }
static double g; static double setg(double v){ g=v; return v; }
typedef union { double d; float f; unsigned long long u; unsigned i; } U;
static void pd(double d){ U x; x.d=d; printf("%llx ",x.u); } static void pf(float f){ U x; x.u=0; x.f=f; printf("%x ",x.i); }
int main(void){ for(int i=0;i<2000;i++){ double a=r(),b=r(),c=r(),e=r(); float fa=a,fb=b,fc=c; 
 pd(a*b+c); pd(a*b-c); pd(c+a*b); pd(c-a*b); pd(-(a*b)+c); pd(-(a*b)-c); pd(c+-(a*b)); pd(c- -(a*b)); pd((a*b)+c); pd(a*b+c*e); pd(a*b-c*e); pd(a*b+c+e); pd(c+e*a*b); pd(2.0*3.0+c); pd(a*2.0+c); pd((double)(fa*fb)+c);
 pf(fa*fb+fc); pf(fa*fb-fc); pf(fc+fa*fb); pf(fc-fa*fb); pf(-(fa*fb)+fc); pf(fa*fb+fc*fa); pd(fa*fb+c); pd(c-fa*fb);
 double x=c; x+=a*b; pd(x); x-=a*b; pd(x); double y=c; double *p=&y; *p+=a*b; pd(y); *p-=(a*b); pd(y); float z=fc; z+=fa*fb; pf(z); z-=fa*fb; pf(z); z=fc; z+=a*b; pf(z); int n=i; n+=a*b; printf("%d ",n); long long m=i; m-=a*b; printf("%lld ",m);
 g=c; g+=a*setg(b); pd(g); double t=a*b; pd(t+c); pd(a/b+c); pd((a+b)*c+e); printf("\n"); }
 pd(1e308*10+-1e308*10); pd(1e-320*0.5+0); pd(5e-324*0.5+5e-324); pd(0.0*1e308-0.0); pd(-0.0*1+0.0); pd(1e308*1e308-INFINITY); pd(NAN*1+1); pd(INFINITY*0+1); pd(1.0000000000000002*1.0000000000000002-1.0000000000000004); volatile double v=1.0000000000000002; pd(v*v-1.0000000000000004); pd(-v*v+1.0000000000000004); printf("\n"); return 0; }
