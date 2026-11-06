#include <stdio.h>
static _Thread_local int t=4; static __thread int u=5; int main(void){ t++; int *p=&t; *p+=u; printf("%d\n",t); return 0; }