#include <stdio.h>
int main(void){ unsigned long long u=0xFFFFFFFFFFFFFFFFULL; long long s=0x7FFFFFFFFFFFFFFFLL; unsigned long long *up=&u; unsigned v=0xFFFFFFFF; unsigned *vp=&v; int sh=63;
 printf("%llu %llu %llu\n",u<<1,(u<<4)>>4,~(u<<60)); u<<=4; printf("%llu\n",u); *up<<=4; printf("%llu\n",u); u=(u<<sh)|(u>>1); printf("%llu\n",u); printf("%llu %llu %llu\n",u+u,u*u,-u); printf("%lld\n",(long long)(u^(u<<3)));
 printf("%u %u %u %u\n",v<<4,(v<<4)>>4,v+v,v*v); v<<=4; printf("%u\n",v); *vp<<=4; printf("%u %u\n",v,-v); s=(long long)((unsigned long long)s<<1); printf("%lld\n",s); printf("%lld %llu\n",s>>1,(unsigned long long)s>>1);
 unsigned short h=0xFFFF; printf("%d %u\n",h<<8,(unsigned)h<<24); unsigned long ul=1; ul<<=63; ul<<=1; printf("%lu\n",ul); long long ll=1; ll<<=62; printf("%lld\n",ll); struct { unsigned long long q; } t={1ULL<<63}; t.q<<=1; printf("%llu\n",t.q); unsigned long long a[1]={1ULL<<63}; a[0]<<=1; printf("%llu %d\n",a[0],(u<<1)==(u+u)); return 0; }
