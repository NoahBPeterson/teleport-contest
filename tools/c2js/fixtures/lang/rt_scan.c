#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#define NEL(a) ((int)(sizeof(a)/sizeof((a)[0])))
static const char *in[]={"","   ","0","42"," 42 ","-42","+42","0x1F","0X1f","077","09","1e5","12abc","abc","abc def","a,b","99999999999","-99999999999","18446744073709551616","3.14","-.5","+.5e3",".","e5","1e","1e+","0x","0xg","\t\n 7","7 8 9","7,8","%","%d","hello world 12","12:34:56","2026-11-05","[x]","x]y","-","+","--1","+-1","nan","inf","INF","infinity","-inf","NaN(1)","0x1p3","1.5e308","1e309","1e-400","\xff\xfe","a\nb"};
static const char *fm[]={"%d","%i","%u","%x","%X","%o","%ld","%lld","%hd","%hhd","%lu","%llu","%3d","%1d","%*d","%d%d","%d %d","%d,%d","%d:%d:%d","%d-%d-%d","%s","%3s","%s %s","%c","%3c"," %c","%[a-z]","%[^,]","%[]x]","%[^]]","%[a-]","%5[0-9]","%*s %s","%d%n","%s%n","%n","x%d","%%%d","%%","abc","abc%d","a b","  %d","%d  ","%f","%lf","%e","%g","%Lf","%5f","%p"};
int main(void){
  for(int i=0;i<NEL(in);i++)for(int j=0;j<NEL(fm);j++){
    long long a[4];char s[3][128];double d;float fl;long double ld;int r;int n=-7;
    memset(a,0x5a,sizeof a);memset(s,0,sizeof s);d=-1;fl=-1;ld=-1;strcpy(s[0],"U");strcpy(s[1],"U");
    const char *f=fm[j];size_t L=strlen(f);
    if(!strcmp(f,"%s")||!strcmp(f,"%3s")||!strcmp(f,"%c")||!strcmp(f,"%3c")||!strcmp(f," %c")||f[1]=='['||!strcmp(f,"%5[0-9]")){r=sscanf(in[i],f,s[0]);printf("%d/%d r=%d [%s]\n",i,j,r,s[0]);}
    else if(!strcmp(f,"%s %s")){r=sscanf(in[i],f,s[0],s[1]);printf("%d/%d r=%d [%s][%s]\n",i,j,r,s[0],s[1]);}
    else if(!strcmp(f,"%*s %s")){r=sscanf(in[i],f,s[0]);printf("%d/%d r=%d [%s]\n",i,j,r,s[0]);}
    else if(!strcmp(f,"%s%n")){r=sscanf(in[i],f,s[0],&n);printf("%d/%d r=%d [%s] n=%d\n",i,j,r,s[0],n);}
    else if(!strcmp(f,"%d%n")){int x=-9;r=sscanf(in[i],f,&x,&n);printf("%d/%d r=%d %d n=%d\n",i,j,r,x,n);}
    else if(!strcmp(f,"%n")){r=sscanf(in[i],f,&n);printf("%d/%d r=%d n=%d\n",i,j,r,n);}
    else if(!strcmp(f,"%f")||!strcmp(f,"%e")||!strcmp(f,"%g")||!strcmp(f,"%5f")){r=sscanf(in[i],f,&fl);printf("%d/%d r=%d %.9g\n",i,j,r,fl);}
    else if(!strcmp(f,"%lf")){r=sscanf(in[i],f,&d);printf("%d/%d r=%d %.17g\n",i,j,r,d);}
    else if(!strcmp(f,"%Lf")){r=sscanf(in[i],f,&ld);printf("%d/%d r=%d %.17Lg\n",i,j,r,ld);}
    else if(!strcmp(f,"%ld")||!strcmp(f,"%lu")){long x=-9;r=sscanf(in[i],f,&x);printf("%d/%d r=%d %ld\n",i,j,r,x);}
    else if(!strcmp(f,"%lld")||!strcmp(f,"%llu")){long long x=-9;r=sscanf(in[i],f,&x);printf("%d/%d r=%d %lld\n",i,j,r,x);}
    else if(!strcmp(f,"%hd")){short x=-9;r=sscanf(in[i],f,&x);printf("%d/%d r=%d %d\n",i,j,r,x);}
    else if(!strcmp(f,"%hhd")){signed char x=-9;r=sscanf(in[i],f,&x);printf("%d/%d r=%d %d\n",i,j,r,x);}
    else if(!strcmp(f,"%p")){continue;}
    else{int x[4]={-9,-9,-9,-9};r=sscanf(in[i],f,&x[0],&x[1],&x[2],&x[3]);printf("%d/%d r=%d %d %d %d\n",i,j,r,x[0],x[1],x[2]);}
    (void)L;(void)a;
  }
  int ba[]={0,2,8,10,16,36,1,37,-1};
  for(int i=0;i<NEL(in);i++){
    char *e;errno=0;int z;
    for(int b=0;b<NEL(ba);b++){
      e=NULL;errno=0;long v=strtol(in[i],&e,ba[b]);printf("strtol %d %d=%ld e=%d errno=%d\n",i,ba[b],v,e?(int)(e-in[i]):-1,errno);
      e=NULL;errno=0;unsigned long u=strtoul(in[i],&e,ba[b]);printf("strtoul %d %d=%lu e=%d errno=%d\n",i,ba[b],u,e?(int)(e-in[i]):-1,errno);}
    e=NULL;errno=0;double d=strtod(in[i],&e);printf("strtod %d=%.17g e=%d errno=%d\n",i,d,(int)(e-in[i]),errno);
    z=atoi(in[i]);printf("atoi %d=%d atol=%ld atof=%.17g\n",i,z,atol(in[i]),atof(in[i]));
  }
  return 0;}
