#include <stdio.h>
static int Math=1, cptr=2; static int BigInt(int v){ return v+1; }
int main(void){ short i16=70; unsigned short u16=65535; signed char schar=127; unsigned char uchar=255; int imul=3; long long i64=5; unsigned long long u64=6; float fround=1.5f; unsigned u32=7; int Number=8, Object=9, undefined=10, NaN=11, Infinity=12, arguments=13, eval=14;
 u16+=1; i16*=1000; schar++; uchar++; imul*=imul; i64*=i64; u64-=7; fround*=1.1f; u32-=8; int d=7/imul; unsigned ud=u32/3; printf("%d %d %d %d %d %lld %llu %f %u %d %u\n",u16,i16,schar,uchar,imul,i64,u64,fround,u32,d,ud);
 printf("%d %d %d %d %d %d %d %d %d %d\n",Math,cptr,BigInt(1),Number,Object,undefined,NaN,Infinity,arguments,eval); char b[8]; int *p=&Math; *p=4; sprintf(b,"%d",*p); printf("%s %f\n",b,(double)(Number*1.5)); return 0; }
