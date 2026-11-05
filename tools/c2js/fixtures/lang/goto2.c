#include <stdio.h>
static int g1(int n){ int s=0,i=0; top: switch(n){ case 0: s+=1; n=2; goto top; case 1: s+=2; goto end; case 2: for(i=0;i<3;i++){ if(i==2){ n=1; goto top;} s+=10; } default: s=-1; } end: return s; }
static int g2(int n){ int s=0; int i=0; if(n) goto in; {for(i=0;i<4;i++){ s+=i; if(0){ in: s+=100; } s+=1; }} return s; }
static int g3(int n){ int s=0; while(n>0){ n--; if(n==3) goto a; if(n==1) goto b; s+=1; continue; a: s+=10; continue; b: s+=100; break; } return s; }
static int g4(int n){ int s=0; switch(n){ case 1: lab: s+=1; if(s<3) goto lab; break; case 2: s=9; goto lab; default: { s=5; goto lab2; } } return s; lab2: s*=3; if(s<40) goto lab2; return s; }
static int g5(int n){ int s=0,i=0; L1: i++; if(i>n) goto L3; L2: s+=i; if(s%2) goto L1; s+=1; if(s>20) goto L3; goto L2; L3: return s; }
static int g6(int n){ int s=0; { int a[3]={1,2,3}; if(n) goto x; s+=a[0]; x: s+=a[2]; } do { if(n==2) goto y; s+=1; y: s+=2; } while(0); return s; }
static int g7(int n){ int s=0; for(;;){ for(;;){ s++; if(s>n) goto out; if(s%2) break; } s+=2; } out: return s; }
static int g8(int n){ int s=0; struct {int a;int b;} p={1,2}; if(n) goto z; { struct {int a;int b;} q={3,4}; q.a=9; s+=q.a; z: s+=p.b; } return s; }
static int g9(int n){ void *t[2]={&&la,&&lb}; goto *t[n]; la: return 11; lb: return 22; }
static int g10(int n){ int s=0; switch(n) { default: goto e; case 1: { static int k=3; while(k--){ case 2: s+=k+5; if(s>12) goto e; } } } e: return s; }
int main(void){ printf("%d %d %d %d %d %d %d %d %d %d\n",g1(0),g2(1),g3(6),g4(1),g5(5),g6(0),g7(9),g8(1),g9(1),g10(1));
 printf("%d %d %d %d %d %d %d %d %d %d\n",g1(2),g2(0),g3(2),g4(2),g5(2),g6(2),g7(4),g8(0),g9(0),g10(2));
 printf("%d\n",g4(7)); return 0; }
