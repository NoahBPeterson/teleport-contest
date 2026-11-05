#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
struct P{int x,y;};static int sum(struct P p){return p.x+p.y;}int main(void){int *q=(int[]){3,4};printf("%d %d %d %d\n",((int[]){3,4})[1],q[0],sum((struct P){.y=2,.x=5}),(int){7});return 0;}
