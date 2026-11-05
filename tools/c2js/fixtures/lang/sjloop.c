#include <stdio.h>
#include <setjmp.h>
static jmp_buf jb;
static void th(int v){ longjmp(jb,v); }
int main(void){ int i,s=0;
 for(i=0;i<5;i++){ if(setjmp(jb)==0){ if(i==1) continue; if(i==3) break; th(i+1);} else { s+=i*10; if(i==2) continue; } s++; }
 printf("%d %d\n",i,s);
 int r=setjmp(jb); if(r<2){ s+=r; th(r+1);} printf("%d %d\n",r,s);
 volatile int k=0; while(1){ int c=setjmp(jb); k++; if(c==0) th(5); if(k>3) break; }
 printf("%d\n",k); return 0;}
