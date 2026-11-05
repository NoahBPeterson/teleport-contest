#include <stdio.h>
int main(void){ int a[3]={1,2,3}; int (*p)[3]=&a; int *e=(int*)(&a+1); char *c=(char*)&a; printf("%d %d %d %d\n",(*p)[2],e[-1],c[4],(int)((char*)e-c)); return 0; }