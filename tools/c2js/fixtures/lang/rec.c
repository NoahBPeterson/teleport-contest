#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
struct in { short a; char b[3]; }; struct S { char c; struct in i; long long l; struct in arr[2]; int *p; double d; float f; union { int x; float y; } u; int (*fn)(int); };
static int dbl(int v){ return v*2; } static int inc(int v){ return v+1; }
static struct S gs={1,{2,"ab"},3,{{4,"cd"},{5,{'e'}}},0,1.5,2.5f,{.y=1.0f},dbl};
static struct S mk(int k){ struct S s=gs; s.c=k; s.i.b[1]='z'; s.arr[1].a=k*2; s.fn=inc; return s; }
static void mod(struct S s){ s.c=99; s.arr[0].a=99; } static void modp(struct S *s){ s->c=77; s->arr[0].a=77; s->i.b[0]='q'; }
static struct in ret(struct S *s,int i){ return s->arr[i]; }
static int sum(int a[],int n){ int t=0; while(n--) t+=*a++; return t; } static int sm2(int m[][3],int r){ int t=0; for(int i=0;i<r;i++) for(int j=0;j<3;j++) t+=m[i][j]; return t; }
struct node { int v; struct node *next; }; static struct node *push(struct node *h,int v){ struct node *n=malloc(sizeof *n); n->v=v; n->next=h; return n; }
typedef struct P { int x,y; } P; static P add(P a,P b){ P r={a.x+b.x,a.y+b.y}; return r; } static P ga[3]={{1,2},{3,4},{5,6}};
struct B { unsigned a:3; int b:5; unsigned long long c:40; unsigned d:1; }; 
union V { unsigned char b[8]; unsigned short s[4]; unsigned u[2]; unsigned long long q; double d; float f; int i; };
static int cnt(void){ static int k=10; return k++; } static int fact(int n){ return n<2?1:n*fact(n-1); }
static const char *names[]={"zero","one","two"}; static int cmps(const void *a,const void *b){ return strcmp(*(const char**)a,*(const char**)b); }
int main(void){ struct S a=mk(7),b; b=a; b.arr[0].b[0]='Z'; mod(a); printf("%d %d %d %c %c %c %d %d\n",a.c,a.arr[0].a,a.arr[1].a,a.i.b[1],a.arr[0].b[0],b.arr[0].b[0],a.fn(1),gs.fn(4));
 modp(&b); printf("%d %d %c %d\n",b.c,b.arr[0].a,b.i.b[0],ret(&b,1).a); struct S *ps=&a; (*ps).l=-5; ps->d*=2; ps->f/=2; ps->u.x=0x3F800000; printf("%lld %f %f %f %zu %zu\n",ps->l,ps->d,ps->f,ps->u.y,sizeof(struct S),sizeof(struct in));
 struct S tt[2]; tt[0]=gs; tt[1]=tt[0]; tt[1].c=5; memset(&tt[0],0,sizeof tt[0]); printf("%d %d %d %f\n",tt[0].c,tt[1].c,tt[1].arr[1].a,tt[1].d); struct in *ip=&tt[1].arr[0]; ip++; printf("%d %c %d\n",ip->a,ip->b[0],(int)(ip-tt[1].arr));
 P p1={1,2},p2; p2=p1; P *pp=&p1; p2=*pp; p1.x=9; P c=add(p1,p2); P d=1?p1:p2; printf("%d %d %d %d %d\n",p2.x,c.x,c.y,d.x,add(ga[0],ga[2]).y); ga[1]=ga[2]; ga[2].x=0; P *gp=ga+1; printf("%d %d %d %d\n",ga[1].x,gp->y,gp[1].x,(gp+1)->y);
 int m[2][3]={{1,2,3},{4,5,6}}; int v[]={1,2,3,4}; printf("%d %d %d %zu %zu\n",sum(v,4),sum(m[1],3),sm2(m,2),sizeof m[0],sizeof v/sizeof*v);
 struct node *h=0; for(int i=0;i<4;i++) h=push(h,i); int t=0; for(struct node *n=h;n;n=n->next) t=t*10+n->v; printf("%d\n",t); struct node **ind=&h; while(*ind&&(*ind)->v!=2) ind=&(*ind)->next; struct node *del=*ind; *ind=del->next; free(del); t=0; for(struct node *n=h;n;n=n->next) t=t*10+n->v; printf("%d\n",t);
 struct B bf={7,-3,0xFFFFFFFFFFULL,1}; struct B *bp=&bf; bp->a+=2; bp->b-=20; bp->c+=2; bp->d^=1; printf("%u %d %llu %u %zu\n",bf.a,bf.b,(unsigned long long)bf.c,bf.d,sizeof bf);
 union V u; u.q=0x0102030405060708ULL; printf("%d %d %u %x\n",u.b[0],u.s[1],u.u[1],u.i); u.d=1.0; printf("%llx %d\n",u.q,u.b[7]); u.f=1.0f; printf("%x\n",u.u[0]); union V w=u; w.b[0]=0xAA; printf("%x %x\n",u.u[0],w.u[0]);
 printf("%d %d %d %d\n",cnt(),cnt(),cnt(),fact(10)); const char *srt[]={"pear","apple","fig"}; qsort(srt,3,sizeof srt[0],cmps); printf("%s %s %s %s\n",srt[0],srt[1],srt[2],names[1]);
 char buf[32]; strcpy(buf,"hello"); strcat(buf," world"); printf("%s %zu %d %d %d\n",buf,strlen(buf),strcmp("a","b"),strncmp("abc","abd",2),memcmp("ab","ac",2)); printf("%s %s %s %s\n",strchr(buf,'o'),strrchr(buf,'o'),strstr(buf,"wor"),strchr(buf,'q')?"y":"n"); memmove(buf+1,buf,5); buf[6]=0; printf("%s\n",buf); strncpy(buf,"xy",5); printf("%s %d\n",buf,buf[4]); memset(buf,'A',3); printf("%c%c%c\n",buf[0],buf[1],buf[2]);
 char sb[40]; int k=sprintf(sb,"%d:%s:%c:%5.1f",1,"two",'3',4.0); printf("%s %d\n",sb,k); k=snprintf(sb,5,"%d",123456); printf("%s %d\n",sb,k); int q1,q2; char qs[8]; k=sscanf("12 abc 0x1f","%d %7s %i",&q1,qs,&q2); printf("%d %d %s %d\n",k,q1,qs,q2); printf("%d %ld %f %d %d %d %c\n",atoi("-42x"),strtol("ff",0,16),atof("2.5e1"),isdigit('5')!=0,isalpha('5')!=0,isspace(' ')!=0,toupper('q')); 
 char tk[]="a,b;c"; char *tp=strtok(tk,",;"); int nt=0; while(tp){ nt++; printf("%s",tp); tp=strtok(0,",;"); } printf(" %d\n",nt); int *dyn=calloc(3,sizeof(int)); dyn[1]=5; dyn=realloc(dyn,6*sizeof(int)); dyn[5]=9; printf("%d %d %d\n",dyn[0],dyn[1],dyn[5]); free(dyn); double *dd=malloc(2*sizeof *dd); dd[1]=1.5; void *vp=dd; printf("%f\n",((double*)vp)[1]); char *cpd=(char*)dd; printf("%d\n",cpd[15]); 
 int (*fp)(int)=dbl; int (**fpp)(int)=&fp; printf("%d %d %d\n",(*fp)(2),(**fpp)(3),fp==dbl); int x=3; int *ax=&x,**axx=&ax; **axx=4; printf("%d %d\n",x,*&x); static int sarr[3]; sarr[1]=2; int *sp=sarr; sp[2]=sp[1]+1; printf("%d\n",sarr[2]); char str2[]="abc"; char *ptr2="abc"; printf("%zu %zu %d\n",sizeof str2,sizeof ptr2,str2[3]);
 return 0; }
