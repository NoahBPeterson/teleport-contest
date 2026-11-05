#include <stdio.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
typedef int (*binop)(int,int); static int add(int a,int b){return a+b;} static int mul(int a,int b){return a*b;}
static binop tb[2][2]={{add,mul},{mul,add}};
static binop pick(int i){ return i?mul:add; } static int (*pick2(int i))(int,int){ return pick(i); }
struct fl { int n; char d[]; };
struct tree { int v; struct tree *k[2]; const char *nm; int m[2][2]; };
static struct tree leaf={1,{0,0},"leaf",{{1,2},{3,4}}}; static struct tree root={2,{&leaf,&leaf},"root",{[1]={[0]=8}}};
static char names[3][6]={"ab","cde",{'x','y'}}; static const char *strs[]={"one","two",0};
static int (*ap)[2]=leaf.m; union mix { int i; char c[4]; short s[2]; float f; struct { char a,b; } p; };
static union mix um[2]={{.i=0x01020304},{.c={1,2,3,4}}};
typedef enum { A=-1,B,C=5,D } E; static E earr[]={B,C,[3]=D};
static int sumv(int n,...){ va_list v; va_start(v,n); int s=0; for(int i=0;i<n;i++) s+=va_arg(v,int); va_end(v); return s; }
static double sumd(const char *f,...){ va_list v,w; va_start(v,f); va_copy(w,v); double s=0; for(;*f;f++){ if(*f=='d') s+=va_arg(v,int); else if(*f=='f') s+=va_arg(v,double); else if(*f=='s') s+=strlen(va_arg(v,char*)); else if (*f=='l') s+=va_arg(v,long long);} va_end(v); va_end(w); return s; }
static int fwd(char *b,const char *f,...){ va_list v; va_start(v,f); int r=vsprintf(b,f,v); va_end(v); return r; }
static int cmp(const void *a,const void *b){ return *(const int*)a-*(const int*)b; }
struct big { int a[4]; char s[5]; }; static struct big mk(int x){ struct big b={{x,x+1},"hey"}; return b; } static int rd(struct big b){ b.a[0]=99; return b.a[0]+b.a[1]; }
int main(void){ char b[64]; struct big bb=mk(3); struct fl *f=malloc(sizeof *f+4); f->n=4; strcpy(f->d,"abc");
 printf("%d %d %d %d\n",tb[0][1](3,4),tb[1][1](3,4),pick(1)(2,5),pick2(0)(2,5));
 printf("%s %d %zu %c\n",f->d,f->n,sizeof(struct fl),f->d[1]);
 printf("%d %d %d %s %d %d\n",root.k[1]->m[1][0],root.m[1][0],root.v,root.k[0]->nm,ap[1][1],(*ap)[1]);
 printf("%s %s %c %s %s %zu\n",names[0],names[1],names[2][1],strs[1],strs[2]?"x":"null",sizeof names);
 printf("%d %d %d %d %d\n",um[0].c[0],um[0].s[1],um[1].i,um[1].p.b,earr[3]);
 printf("%d %.2f %d %s\n",sumv(3,1,2,3),sumd("dfsl",1,2.5,"abc",10LL),fwd(b,"%d-%s",5,"q"),b);
 int q[5]={5,1,4,2,3}; qsort(q,5,sizeof q[0],cmp); printf("%d%d%d%d%d\n",q[0],q[1],q[2],q[3],q[4]);
 printf("%d %d %d %s %d\n",mk(5).a[1],rd(bb),bb.a[0],mk(1).s,(int)offsetof(struct big,s));
 _Atomic int at=3; at+=4; printf("%d\n",at); int *rp=&(int){7}; printf("%d\n",*rp);
 const char *cs="hi" " there"; printf("%s %zu %zu\n",cs,sizeof("hi"),sizeof(L"hi"));
 int mat[2][3]={{1,2,3},{4,5,6}}; int (*row)[3]=mat+1; printf("%td %zu %d\n",row-mat,sizeof(*row),*(*row+2));
 int (*fparr[2])(int,int)={add,mul}; int (**fpp)(int,int)=fparr; printf("%d\n",fpp[1](6,7));
 char c='A'; c+=1; signed char sc=-1; unsigned char uc=sc; short sh=70000; long long ll=-1; printf("%c %d %d %lld %llu\n",c,uc,sh,ll>>1,(unsigned long long)ll>>60);
 return 0; }
