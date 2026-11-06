#include <stdio.h>
#include <string.h>
#include <limits.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
static const char *fl[]={"","-","+"," ","0","#","-+","+0","- ","#0","-#","+ ","-0"};
static const char *wd[]={"","1","5","12"};
static const char *pr[]={"",".",".0",".1",".5",".12"};
static char f[64],b[256];
#define NEL(a) ((int)(sizeof(a)/sizeof((a)[0])))
#define LOOP(BODY) for(int i=0;i<NEL(fl);i++)for(int j=0;j<NEL(wd);j++)for(int k=0;k<NEL(pr);k++){BODY}
int main(void){
  int iv[]={0,1,-1,42,-42,INT_MAX,INT_MIN,255};
  const char *ic="diuoxX";
  for(const char *c=ic;*c;c++)for(int v=0;v<NEL(iv);v++)LOOP(
    snprintf(f,sizeof f,"%%%s%s%s%c",fl[i],wd[j],pr[k],*c);
    int r=snprintf(b,sizeof b,f,iv[v]);printf("[%s|%d]=%d[%s]\n",f,iv[v],r,b);)
  long long lv[]={0,1,-1,LLONG_MAX,LLONG_MIN,4294967296LL,-4294967297LL};
  for(const char *c=ic;*c;c++)for(int v=0;v<NEL(lv);v++)for(int i=0;i<NEL(fl);i+=2){
    snprintf(f,sizeof f,"%%%s12ll%c",fl[i],*c);snprintf(b,sizeof b,f,lv[v]);printf("[%s]=[%s]\n",f,b);
    snprintf(f,sizeof f,"%%%sl%c",fl[i],*c);snprintf(b,sizeof b,f,(long)lv[v]);printf("[%s]=[%s]\n",f,b);
    snprintf(f,sizeof f,"%%%sz%c",fl[i],*c);snprintf(b,sizeof b,f,(size_t)lv[v]);printf("[%s]=[%s]\n",f,b);
    snprintf(f,sizeof f,"%%%sj%c",fl[i],*c);snprintf(b,sizeof b,f,(intmax_t)lv[v]);printf("[%s]=[%s]\n",f,b);
    snprintf(f,sizeof f,"%%%st%c",fl[i],*c);snprintf(b,sizeof b,f,(ptrdiff_t)lv[v]);printf("[%s]=[%s]\n",f,b);
    snprintf(f,sizeof f,"%%%sh%c",fl[i],*c);snprintf(b,sizeof b,f,(int)lv[v]);printf("[%s]=[%s]\n",f,b);
    snprintf(f,sizeof f,"%%%shh%c",fl[i],*c);snprintf(b,sizeof b,f,(int)lv[v]);printf("[%s]=[%s]\n",f,b);
  }
  volatile double dv[]={0.0,-0.0,1.0,-1.0,0.5,1.5,2.5,3.5,0.1,0.125,1.005,2.675,99.5,999.5,1e10,1e15,1e16,1e20,1e21,1e22,1e100,1.5e300,1e-5,1e-4,1e-300,5e-324,1.7976931348623157e308,123456789.125,0.000123456,1234567.0,1e5,1e6,100000.5,INFINITY,-INFINITY,NAN};
  const char *dc="feEgGF";
  for(const char *c=dc;*c;c++)for(int v=0;v<NEL(dv);v++)LOOP(
    snprintf(f,sizeof f,"%%%s%s%s%c",fl[i],wd[j],pr[k],*c);
    double dd=dv[v];int r=snprintf(b,sizeof b,f,dd);printf("[%s|%d]=%d[%s]\n",f,v,r,b);)
  for(int v=0;v<NEL(dv);v++){double dd=dv[v];
    for(int p=0;p<25;p+=3){printf("%.*f|%.*e|%.*g\n",p,dd,p,dd,p,dd);}
    printf("%.14g %.17g %a\n",dd,dd,dd);}
  const char *sv[]={"","a","hello world","\xff\xfe high",NULL};
  const char *sc[]={"%s","%10s","%-10s","%.3s","%10.3s","%-10.3s","%.0s","%1s","%05s","%+s","%#s","% s"};
  for(int v=0;v<NEL(sv);v++)for(int i=0;i<NEL(sc);i++){int r=snprintf(b,sizeof b,sc[i],sv[v]);printf("[%s]=%d[%s]\n",sc[i],r,b);}
  int cv[]={0,'A',255,-1,256+65,127,128};
  const char *cc[]={"%c","%5c","%-5c","%05c","%+c","%.2c"};
  for(int v=0;v<NEL(cv);v++)for(int i=0;i<NEL(cc);i++){int r=snprintf(b,sizeof b,cc[i],cv[v]);printf("[%s]=%d:",cc[i],r);for(int z=0;z<r&&z<20;z++)printf("%02x",(unsigned char)b[z]);printf("\n");}
  for(int n=0;n<8;n++){memset(b,'#',16);b[16]=0;int r=snprintf(b,n,"%s-%d","abc",12345);printf("n=%d r=%d [",n,r);for(int z=0;z<10;z++)printf("%02x",(unsigned char)b[z]);printf("]\n");}
  printf("%d %s %5.2f %c %%|%-5d|%05d|%x\n",1,"two",3.0,'4',5,6,7);
  printf("%2$d %1$d|\n",1,2);
  printf("%*d|%-*d|%*d|%.*f|%.*f|%*.*f\n",5,1,5,2,-5,3,2,3.14159,-2,3.14159,8,3,2.5);
  printf("%%|%5%|%-5%|\n");
  printf("%y|%k|%|\n",1,2);
  printf("%hd %hu %hhd %hhu %hx\n",70000,70000,300,300,70000);
  printf("%D %U %O\n",70000L,70000L,70000L);
  printf("%ld %lu %lx %lld %llu %llx\n",-1L,-1L,-1L,-1LL,-1LL,-1LL);
  printf("%lf %Lf %le %lg\n",1.5,(long double)2.5,3.5,4.5);
  
  int n1=0;printf("abc%ndef\n",&n1);printf("%d\n",n1);
  char big[600];memset(big,'x',599);big[599]=0;printf("%d\n",snprintf(b,sizeof b,"%s",big));
  printf("%500d|\n",1);printf("%.300d|\n",1);printf("%.400f|\n",1.0/3);
  return 0;}
