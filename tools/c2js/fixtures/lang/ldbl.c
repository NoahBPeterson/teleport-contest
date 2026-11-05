#include <stdio.h>
#include <string.h>
#include <float.h>
long double h(long double x){ return x*x+1.5L; }
int main(void){ long double a=1.25L,b[3]={1,2,3}; struct { long double v; int k; } s={2.5L,3};
 union { long double d; unsigned long long u; } un; un.d=1.0L;
 printf("%zu %zu %d %Lf %Lg %.3Le %f\n",sizeof a,sizeof s,LDBL_MANT_DIG,h(a),b[1]+s.v,a*3,(double)a);
 printf("%llx\n",un.u); int i=(int)(a*10); unsigned char x[8]; memcpy(x,&a,8); printf("%d %d %d\n",i,x[7],x[6]);
 long double *p=b; p++; *p+=1; printf("%Lf %d\n",p[1]+p[0],a<b[0]); return 0; }
