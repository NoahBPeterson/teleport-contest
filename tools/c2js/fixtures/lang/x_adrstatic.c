#include <stdio.h>
int main(void){ static int a=1; static struct{int b;}s={2}; static int c[2]={3,4}; int *p=&a,*q=&s.b,*r=&c[1]; *p=5;*q=6;*r=7; printf("%d %d %d\n",a,s.b,c[1]); return 0; }