#include <stdio.h>
int main(void){ int t=0; switch(2){ int x; struct{int a;} s; case 1: x=1; break; case 2: x=5; s.a=x; t=s.a; int y=7; t+=y; } printf("%d\n",t); return 0; }