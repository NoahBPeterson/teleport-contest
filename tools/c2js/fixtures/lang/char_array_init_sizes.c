#include <stdio.h>
#include <string.h>
struct S { char a[8]; char b[4]; int n; };
static char gs[32] = "";
static char gt[32] = "ab";
int main(void){
  char w[32]=""; char x[32]="ab"; char y[8]={0}; char z[8]={'a'}; char q[]="abc"; char e[]="";
  struct S s = {"hi"}; struct S t = {"", "x", 3};
  char u[2][8]={"a",""}; char *p[2]={"a",""};
  printf("%d %d %d %d %d %d\n",(int)sizeof w,(int)sizeof x,(int)sizeof y,(int)sizeof z,(int)sizeof q,(int)sizeof e);
  strcpy(w,"hello world"); strcat(x,"cdefghijklmnop"); strcpy(y,"1234567"); strcpy(z,"7654321");
  strcpy(gs,"global long string"); strcat(gt,"more global text");
  strcpy(s.a,"1234567"); strcpy(t.a,"7654321"); strcpy(u[0],"1234567"); strcpy(u[1],"abcdefg");
  sscanf("line one","%s",w);
  printf("%s|%s|%s|%s|%s|[%s]|%s|%s|%s|%s|%d|%s|%s|%s|%s\n",w,x,y,z,q,e,gs,gt,s.a,t.a,t.n,t.b,u[0],u[1],p[0]);
  { static char ss[16]=""; strcpy(ss,"static long"); printf("%s\n",ss); }
  return 0;}
