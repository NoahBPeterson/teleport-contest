#include <stdio.h>
#include <setjmp.h>
static jmp_buf j;
static int a(int x){ volatile int c=0;
  if(x) goto skip;
  if(setjmp(j)){ c+=2; goto out; }
  c=1; longjmp(j,1);
skip: c=50;
out: return c; }
static int b(void){ volatile int c=0;
again:
  if(setjmp(j)==0){ c++; longjmp(j,1); }
  c+=10;
  if(c<30) goto again;
  return c; }
static int d(void){ volatile int c=0; volatile int i;
  for(i=0;i<3;i++){
    if(setjmp(j)){ c+=100; if(i==1) goto done; continue; }
    c++; longjmp(j,1);
  }
done: return c+i*1000; }
int main(void){ printf("%d %d %d %d\n",a(0),a(1),b(),d()); return 0; }
