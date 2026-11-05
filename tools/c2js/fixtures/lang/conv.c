#include <stdio.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
static int n; static int bump(void){ return ++n; }
static int sw(long long v){ switch(v){ case 0x100000000LL: return 1; case -1: return 2; case 5 ... 7: return 3; default: return 0; } }
static int swu(unsigned u){ switch(u){ case 4000000000u: return 1; case 0: return 2; } return 3; }
static int swc(char c){ switch(c){ case 'a': case -1: return 1; case '\377'+0==-1?2:3: return 2; } return 0; }
static int swb(unsigned char c){ switch(c){ case 255: return 1; default: return 2; } }
int main(void){ unsigned char u8=200; signed char s8=-56; unsigned short u16=65535; short s16=-1; unsigned u=1; int i=-1; long long ll=-1; unsigned long long ull=1; 
 printf("%d %d %d %d\n",u8+s8,u8>s8,u16*u16==(int)(65535u*65535u),s16<u);
 printf("%d %d %d %d %d\n",i<u,i<ull,ll<u,(long long)u>ll,(unsigned)i==UINT_MAX);
 printf("%d %d %d\n",1?u8:-1,(0?u8:-1)<0,(1?u:-1)>0);
 printf("%lld %lld %zu\n",(long long)(1?i:ull),(long long)(i+u),sizeof(1?u8:s16));
 printf("%d %u %d %d\n",-u8,-u,~u8,~s8); printf("%d %d %d %d\n",!0.0,!0.5,!!-1,!(void*)0);
 printf("%d %d %d %d %d %d\n",-7/2,-7%2,7/-2,7%-2,INT_MIN%-1==0?1:0,(int)(-7LL/2));
 printf("%u %d %lld %llu\n",u<<31,1<<30,ll>>3,ull<<63); printf("%d %d %d\n",s8>>1,u8>>1,(signed char)(u8<<1));
 printf("%zu %d %zu %zu %zu\n",sizeof(bump()),n,sizeof 'a',sizeof(u8+u8),sizeof(1LL+1));
 printf("%d %d %d %d\n",sw(0x100000000LL),sw(-1),sw(6),sw(99)); printf("%d %d %d %d %d\n",swu(4000000000u),swu(0),swc(-1),swc(2),swb(255));
 int a=0,b=0; int r=(a++&&b++)+(a++||b++)+(!a&&b++); printf("%d %d %d\n",r,a,b); r=(a=5,b=6,a+b); printf("%d\n",r);
 double nan=NAN,inf=INFINITY; printf("%d %d %d %d %d\n",nan==nan,nan!=nan,nan<1,inf>1e308,(nan<1)||(nan>=1)); printf("%f %f %f %.1f %f %f\n",floor(-1.5),ceil(-1.5),fabs(-2.5),fmod(7.5,2),pow(2,10),sqrt(2));
 float f=0.1f; double d=f; printf("%.10f %.10f %d %d\n",d,(double)(f*f),f==0.1,(float)0.1==f); printf("%f %d %d\n",1.0/3,(int)3.99,(int)-3.99); printf("%g %g %e %5.2f|%-8.3f|%+d|%05d|%x|%X|%o|%c|%s|%%|%5s|%-5s|%.2s\n",1e10,1e-5,12345.678,3.14159,2.5,5,42,255,255,8,'z',"str","ab","ab","abcd");
 printf("%ld %lu %lld %llu %hd %hhd %hu %hhu %zu %zd\n",-5L,5UL,-5LL,5ULL,(short)70000,(char)300,(unsigned short)70000,(unsigned char)300,(size_t)9,(ssize_t)-9);
 printf("%lld %lld %d %d %u\n",LLONG_MAX,LLONG_MIN,INT_MAX,INT_MIN,UINT_MAX); printf("%llu\n",ULLONG_MAX);
 uint32_t x32=0xFFFFFFFF; x32+=2; uint16_t x16=0xFFFF; x16++; uint8_t x8=0; x8--; int8_t y8=127; y8++; int16_t y16=-32768; y16--; printf("%u %u %u %d %d\n",x32,x16,x8,y8,y16);
 uint64_t m=0xFFFFFFFFFFFFFFFFULL; m*=m; int64_t im=INT64_MAX; im=(int64_t)((uint64_t)im+1); printf("%llu %lld %llu %llu\n",m,im,m/3,(0xFFFFFFFFFFFFFFFFULL)%10);
 char c=-1; int ci=c; unsigned cu=c; unsigned char cc=c; printf("%d %u %d %d\n",ci,cu,cc,c=='\377'); char arr[3]={1,2,3}; char *cp=arr+2; printf("%d %d %d\n",cp[-1],*(cp-2),(int)(cp-arr));
 long l=1; l<<=40; int trunc=(int)l; short st=(short)0x12345; char ct=(char)0x1FF; printf("%ld %d %d %d\n",l,trunc,st,ct); unsigned long ul=(unsigned)-1; long sl=(int)-1; printf("%lu %ld %lu\n",ul,sl,(unsigned long)(int)-1);
 _Bool bb=5; _Bool b2=0.5; _Bool b3=(void*)&n; bb+=1; printf("%d %d %d\n",bb,b2,b3); bb=0; bb--; printf("%d\n",bb);
 enum e{EA=-1,EB=5} ee=EA; printf("%d %d %d\n",ee<0,ee==-1,(int)sizeof ee); int tern=n?n>0?1:2:3; printf("%d\n",tern);
 printf("%d %d\n",'a'+1,"abc"[1]); printf("%d\n",(int)sizeof("a\0b")); int v[3]={1,2,3}; int idx=0; v[idx++]+=10; v[idx]=idx; printf("%d %d %d %d\n",v[0],v[1],v[2],idx); int z=1; z+=z++ ,z; printf("%d\n",z>0);
 unsigned short ss=1; ss<<=15; ss<<=1; int prom=ss+(-1); unsigned hi=(unsigned short)-1*(unsigned short)2; printf("%d %d %u\n",ss,prom,hi);
 return 0; }
