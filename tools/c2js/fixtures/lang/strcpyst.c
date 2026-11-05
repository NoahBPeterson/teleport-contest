#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
struct N{char n[8];struct N *next;int v;};int main(void){struct N a={"hi",0,1},b;b=a;b.v=2;a.next=&b;a.next->n[0]=72;printf("%s %s %d\n",a.n,b.n,a.next->v);struct N arr[2]={{"x",0,3},{"y",&a,4}};printf("%s %d %s\n",arr[1].n,arr[0].v,arr[1].next->n);return 0;}
