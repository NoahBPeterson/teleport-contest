#include <stdio.h>
#include <stdint.h>
#pragma pack(push)
#pragma pack(1)
struct S1 { unsigned f0:9; unsigned f1:29; signed f2:2; signed f3:29; const volatile signed :0; volatile int64_t f4; const volatile unsigned f5:13; };
struct T { volatile int64_t a; char c; volatile uint16_t b; int : 0; int d; };
#pragma pack(pop)
struct Z { char a; int :0; char b; long long :0; char c; int x:3; int :0; int y:3; };
static volatile struct S1 g={20,1686,0,15796,0xEF4FC6A3F0BDE8AFLL,3}; static struct T t={-5,1,2,3}; static struct Z z={1,2,3,3,1};
int main(void){ printf("%zu %zu %zu %lld %d %d %d %d\n",sizeof g,sizeof t,sizeof z,(long long)g.f4,g.f5,g.f3,g.f1,g.f0);
 printf("%lld %d %d %d %d %d %d %d %d\n",(long long)t.a,t.c,t.b,t.d,z.a,z.b,z.c,z.x,z.y); g.f4=7; g.f3=-9; volatile struct S1 *p=&g; p->f4+=1; p->f2=1; printf("%lld %d %d %d %d\n",(long long)p->f4,p->f3,p->f2,p->f5,p->f1);
 unsigned char *b=(unsigned char*)&z; printf("%d %d %d %d\n",b[0],b[4],b[8],b[12]); return 0; }
