#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static unsigned long H;static long N;static int ESZ;static char *B;
static int key(const char*p){int v;memcpy(&v,p,sizeof v);return v;}
static int cmp(const void*a,const void*b){int ia=(int)(((const char*)a-B)/ESZ),ib=(int)(((const char*)b-B)/ESZ);
  int ka=key(a)&0xffff0000,kb=key(b)&0xffff0000;
  H=H*1000003UL^(unsigned long)((key(a)&0xffff)*65536+(key(b)&0xffff));N++;(void)ia;(void)ib;
  return ka<kb?-1:ka>kb?1:0;}
static unsigned r_s;static unsigned rr(void){r_s=r_s*1103515245u+12345u;return (r_s>>16)&0x7fff;}
static void fill(char*b,int n,int sz,int pat,int mod){for(int i=0;i<n;i++){int k;switch(pat){case 0:k=i;break;case 1:k=n-i;break;case 2:k=i<n/2?i:n-i;break;case 3:k=rr();break;case 4:k=0;break;case 5:k=rr()%3;break;case 6:k=i%2;break;case 7:k=(i*7)%n;break;case 8:k=(i==n-1)?0:i+1;break;case 9:k=rr()%mod;break;case 10:k=(i+n/2)%n;break;case 11:k=(i==0)?n:i;break;case 12:k=i^1;break;case 13:k=(n-i)%3;break;case 14:{int h=n/2;k=i<h?2*i:2*(i-h)+1;}break;default:k=(i*i)%(n?n:1);}
   int v=(k<<16)|(i&0xffff);memset(b+i*sz,0,sz);memcpy(b+i*sz,&v,4);}}
int main(void){
 int szs[]={4,8,12,16,24,40,1000};int ns[]={0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,24,31,32,33,39,40,41,50,64,100,128,200,500,1000};
 for(int s=0;s<7;s++){int sz=szs[s];for(int c=0;c<35;c++){int n=ns[c];if(sz==1000&&n>64)continue;char*b=malloc(sz*(n+1));
  for(int p=0;p<16;p++){r_s=(unsigned)(n*31+p);fill(b,n,sz,p,5);H=0;N=0;B=b;ESZ=sz;qsort(b,n,sz,cmp);unsigned long o=0;for(int i=0;i<n;i++)o=o*1000003UL^(unsigned)key(b+i*sz);printf("%d %d %d n=%ld h=%lu o=%lu\n",sz,n,p,N,H,o);}
  free(b);}}
 /* inconsistent comparator must not crash and must order the same */
 return 0;}
