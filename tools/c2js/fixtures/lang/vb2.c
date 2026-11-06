#include <stdio.h>
static int calls; static int f(void){ calls++; return 3; }
static int sum(int n,int m,int a[n][m]){ int t=0; int r=m; m=99; for(int i=0;i<n;i++) for(int j=0;j<r;j++) t+=a[i][j]; n=7; return t+(int)sizeof(*a)+(int)sizeof(a[0]); }
int main(void){ int n=2,k=3; int a[n][k]; for(int i=0;i<2;i++) for(int j=0;j<3;j++) a[i][j]=i*10+j;
 int (*p)[k]=a; int z=k; k=50; n=9; printf("%d %d %zu %zu %d\n",p[1][2],a[1][2],sizeof a,sizeof *p,(int)(p+1-p));
 p++; printf("%d %d\n",**p,p[0][1]); p--; printf("%d\n",(*(p+1))[0]); k=z; n=2;
 typedef int R[k]; k=1; R x; x[2]=4; R *rp=&x; printf("%d %zu %zu\n",(*rp)[2],sizeof x,sizeof(R)); k=3;
 int b[f()]; int cnt=calls; b[2]=5; printf("%zu %d %d %d\n",sizeof b,b[2],cnt,calls); int (*c)[f()]=(void*)0; printf("%zu %d\n",sizeof *c,calls);
 for(int i=1;i<3;i++){ int v[i]; int w=i; i+=0; v[0]=w; int (*q)[i]=&v; printf("%zu %d\n",sizeof v,(*q)[0]); }
 int s=2; int d[s]; s++; int e[s]; printf("%zu %zu\n",sizeof d,sizeof e); int y=2; int mm[y][y]; int (*q1)[y]=mm; y=4; int nn[y][y]; int (*q2)[y]=nn; mm[1][1]=1; nn[3][3]=2; printf("%d %d %zu %zu\n",q1[1][1],q2[3][3],sizeof *q1,sizeof *q2);
 printf("%d\n",sum(2,3,a)); int g2=3; printf("%zu\n",sizeof(int[g2])); g2=4; printf("%zu\n",sizeof(int[g2])); return 0; }
