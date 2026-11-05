#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
int main(void){int x=0x01020304;unsigned char *c=(unsigned char*)&x;short sh;int y;float f=1.0f;unsigned u;double d=2.0;long long ll;char *cc;c[1]=0xFF;printf("%d %d %x\n",c[0],c[3],x);memset(&y,1,4);memcpy(&sh,&x,2);memcpy(&u,&f,4);memcpy(&ll,&d,8);printf("%x %x %x %llx\n",y,sh&0xffff,u,ll);cc=(char*)&d;printf("%d\n",cc[7]&255);return 0;}
