#include <stdio.h>
int main(void){ _Bool b[3]={1,0,5}; _Bool *p=b; p[1]=7; printf("%d %d %d %zu\n",b[0],b[1],b[2],sizeof b); return 0; }