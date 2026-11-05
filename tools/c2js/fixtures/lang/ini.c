#include <stdio.h>
union mix { int i; char c[4]; short s[2]; struct { char a,b; } p; };
static union mix um[2]={{.i=0x01020304},{.c={1,2,3,4}}};
static union mix one={.s={5,6}};
typedef enum { A=-1,B,C=5,D } E; static E earr[]={B,C,[3]=D}; static int iarr[]={1,[3]=4,5,[1]=9};
static struct { int a; int b[3]; char c; } st[]={[1]={.b={[2]=7},.c='z'},{1,{2},3}};
int main(void){ union mix l[2]={{.s={1,2}},{.c={9}}}; E le[]={C,[2]=D}; int la[5]={[1]=1,2,[4]=9,[0]=3};
printf("%d %d %d %d %d %zu %d %d %zu\n",um[1].i,um[1].p.b,one.s[1],earr[3],earr[1],sizeof earr,iarr[3],iarr[1],sizeof iarr);
printf("%d %d %d %d %d %d\n",st[1].b[2],st[1].c,st[2].a,st[2].b[0],st[2].c,(int)(sizeof st/sizeof st[0]));
printf("%d %d %d %d %d %d %d\n",l[0].s[1],l[1].c[0],le[2],la[0],la[1],la[2],la[4]);
return 0; }
