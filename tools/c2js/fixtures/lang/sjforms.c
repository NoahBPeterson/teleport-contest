#include <stdio.h>
#include <setjmp.h>
static jmp_buf j; static int n;
static void hop(int v){ longjmp(j,v); }
static int fsw(void){ volatile int t=0;
  switch(setjmp(j)){ case 0: t=1; hop(2); break; case 2: t+=10; hop(3); break; case 3: t+=100; break; default: t=-1; }
  return t; }
static int fassign(void){ volatile int c=0; int r; r=setjmp(j); c++; if(r<3) hop(r+1); return c*10+r; }
static int finit(void){ volatile int c=0; int r=setjmp(j); c++; if(r==0) hop(7); return c*10+r; }
static int fwhile(void){ volatile int c=0; while(setjmp(j)<2){ c++; hop(c); } return c; }
static int fnot(void){ volatile int c=0; if(!setjmp(j)){ c=1; hop(1); } else c+=5; return c; }
static int fvoid(void){ volatile int c=0; (void)setjmp(j); c++; if(c<3) hop(1); return c; }
static int fcmp(void){ volatile int c=0; if(setjmp(j)==0){ c++; hop(9);} else if(c<3){ c++; hop(9);} return c; }
static int fcond(void){ volatile int c=0; int v = setjmp(j)==0 ? 1 : 2; c+=v; if(v==1) hop(1); return c; }
static int fzero(void){ volatile int c=0; if(setjmp(j)==1){ c+=100; return c;} c++; longjmp(j,0); return -1; }
static int fnest(void){ jmp_buf k; volatile int c=0; if(!setjmp(k)){ if(!setjmp(j)){ c=1; longjmp(k,1);} c=2; } else c+=4; return c; }
int main(void){
  printf("%d %d %d %d %d %d %d %d %d %d\n",fsw(),fassign(),finit(),fwhile(),fnot(),fvoid(),fcmp(),fcond(),fzero(),fnest());
  return 0; }
