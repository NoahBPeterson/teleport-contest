#include <stdio.h>
#include <stdarg.h>
struct p{int a;double d;}; static double f(int n,...){ va_list v; va_start(v,n); struct p s=va_arg(v,struct p); char c=(char)va_arg(v,int); void *q=va_arg(v,void*); long long l=va_arg(v,long long); float g=(float)va_arg(v,double); va_end(v); return s.a+s.d+c+(q!=0)+l+g; } int main(void){ struct p s={1,2.5}; printf("%f\n",f(1,s,'A',&s,5LL,1.5f)); return 0; }