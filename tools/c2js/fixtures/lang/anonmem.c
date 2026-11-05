#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
struct S{int a;union{int i;float f;};struct{short x,y;};int k[2];};int main(void){struct S s;memset(&s,0,sizeof s);s.f=1.0f;s.x=2;s.y=3;s.k[1]=7;printf("%x %d %d %d %d\n",s.i,s.x,s.y,s.k[1],(int)sizeof s);return 0;}
