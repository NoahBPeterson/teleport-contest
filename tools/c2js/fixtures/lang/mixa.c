#include <stdio.h>
#include <stdint.h>
#define M(ty,v0,rt,r0) { ty x=v0; ty *p=&x; rt r=r0; ty a=x; a+=r; ty b=x; b-=r; ty c=x; c*=r; ty d=x; d/=r; *p+=r; ty e=*p; *p-=r; *p*=r; ty f=*p; *p/=r; printf("%.3f %.3f %.3f %.3f %.3f %.3f %.3f\n",(double)a,(double)b,(double)c,(double)d,(double)e,(double)f,(double)x); }
int main(void){
 M(int,7,double,2.5) M(int,-7,double,2.5) M(unsigned,7,double,2.5) M(char,7,double,2.5) M(unsigned char,200,double,2.5) M(short,-300,double,2.5) M(unsigned short,3000,float,1.5f) M(long long,7,double,2.5) M(unsigned long long,7,float,2.5f) M(int,9,float,1.5f)
 M(double,7.5,long long,2) M(float,7.5f,long long,3) M(double,7.5,unsigned long long,2) M(float,1.1f,double,3.3) M(double,1.1,float,3.3f) M(float,1.1f,int,3) M(double,1.1,unsigned,3) M(float,1.5f,char,3) M(double,2.5,short,-3)
 M(signed char,-100,int,3) M(unsigned char,200,int,7) M(short,-30000,int,7) M(unsigned short,60000,int,7) M(signed char,-100,long long,3) M(unsigned char,200,unsigned,7) M(short,-30000,unsigned long long,7)
 M(int,-100,unsigned,3) M(unsigned,100,int,-3) M(long long,-100,unsigned,3) M(unsigned long long,100,int,3) M(int,-100,long long,3) M(unsigned,100,long long,-3) M(long long,-100,unsigned long long,3)
 int r=3; signed char sc=100; sc<<=r; short sh=1000; sh<<=r; unsigned char uc=200; uc<<=r; uc>>=1; printf("%d %d %d\n",sc,sh,uc);
 signed char *scp=&sc; int v=(*scp%=7); int w=(*scp*=100); int y=(*scp=300); printf("%d %d %d %d\n",v,w,y,sc);
 unsigned short us=1; unsigned short *usp=&us; int z=(*usp-=2); unsigned u32=1; unsigned *up=&u32; unsigned long long zz=(*up-=2); printf("%d %llu\n",z,zz);
 double dd=1e20; int trunc=(int)2.9; long long ll=(long long)-2.9; unsigned long long ull=(unsigned long long)1e19; printf("%d %lld %llu %f\n",trunc,ll,ull,dd/3);
 float ff=16777216.0f; ff+=1; ff=ff+1.0f; printf("%f %f\n",ff,(double)(ff*1.1f));
 return 0; }
