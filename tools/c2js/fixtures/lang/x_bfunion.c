#include <stdio.h>
union u{struct{unsigned a:4,b:4;}f;unsigned char c;}; int main(void){ union u v; v.c=0xAB; printf("%d %d\n",v.f.a,v.f.b); v.f.b=1; printf("%x\n",v.c); return 0; }