#include <stdio.h>
#include <string.h>
struct s{int a;char b[3];double d;}; int main(void){ struct s x={1,"ab",2.5},y; memcpy(&y,&x,sizeof x); int z=memcmp(&x,&y,sizeof x); int v[3]={1,2,3}; memmove(v+1,v,2*sizeof v[0]); double d=1.5; unsigned char b[8]; memcpy(b,&d,8); double e; memcpy(&e,b,8); memset(v,0xFF,4); printf("%d %s %f %d %d %d %f %d\n",y.a,y.b,y.d,z==0,v[1],v[2],e,v[0]); return 0; }