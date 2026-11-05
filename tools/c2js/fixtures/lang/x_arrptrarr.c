#include <stdio.h>
int main(void){ int x[3]={1,2,3},y[3]={4,5,6}; int (*p[2])[3]={&x,&y}; printf("%d %d\n",(*p[1])[2],p[0][0][1]); return 0; }