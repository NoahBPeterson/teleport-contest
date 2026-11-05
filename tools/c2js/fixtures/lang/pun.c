#include <stdio.h>
#include <string.h>
int main(void){
 float f=1.0f; double d=2.0; unsigned u=0; long long ll=0; short s=-1; unsigned char *c;
 u=*(unsigned*)&f; printf("%x\n",u);
 ll=*(long long*)&d; printf("%llx\n",ll);
 *(unsigned*)&f=0x40000000; printf("%g\n",f);
 void *v=&f; printf("%x\n",*(unsigned*)v); printf("%g\n",*(float*)v);
 int i=7; void *w=&i; int *ip=w; *ip=9; printf("%d\n",i);
 c=(unsigned char*)&s; c[1]=0; printf("%d\n",s);
 unsigned short us=0xfffe; c=(unsigned char*)&us; printf("%d %d\n",c[0],c[1]);
 long long big=0x0102030405060708LL; c=(unsigned char*)&big; printf("%d %d\n",c[0],c[7]); c[7]=9; printf("%llx\n",big);
 memset(&d,0,8); printf("%g\n",d);
 memset(&f,0xff,sizeof f); printf("%x\n",*(unsigned*)&f);
 double dd; long long q=0x3ff8000000000000LL; memcpy(&dd,&q,8); printf("%g\n",dd);
 char ch=65; memcpy(&i,&ch,1); printf("%d\n",i);
 return 0; }
