#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
typedef struct { int a; char b; } anon_t;
static jmp_buf jb;
static void th(int v){ longjmp(jb,v); }
int main(void){ int i; volatile int s=0;
 for(i=0;i<5;i++){ if(setjmp(jb)==0){ if(i==1) continue; if(i==3) break; th(i+1);} else { s+=i*10; if(i==2) continue; } s++; }
 printf("%d %d\n",i,s);
 anon_t t={3,'x'}; printf("%d %c %zu\n",t.a,t.b,sizeof t);
 div_t d=div(-7,2); printf("%d %d\n",d.quot,d.rem);
 printf("%c%c\n",0xC3,0x41); puts(""); puts("x"); putchar('y'); putchar('\n'); fputs("z\n",stdout);
 return 0; }
