#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#pragma pack(push,1)
struct P{char a;int b;short c;};struct Q{unsigned a:3;char b;int c:10;};
#pragma pack(pop)
struct R{char a;int b;}__attribute__((packed));struct A{char a;}__attribute__((aligned(16)));int main(void){struct P p;unsigned char *u=(unsigned char*)&p;memset(&p,0,sizeof p);p.b=0x01020304;p.c=5;printf("%d %d %d %d %d %d %d %d\n",(int)sizeof p,u[1],u[4],p.c,(int)sizeof(struct Q),(int)sizeof(struct R),(int)sizeof(struct A),(int)__alignof__(struct A));return 0;}
