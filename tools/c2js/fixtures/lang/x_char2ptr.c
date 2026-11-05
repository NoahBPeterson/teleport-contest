#include <stdio.h>
int main(void){ const char *a[2][2]={{"a","b"},{"c",0}}; printf("%s %d %zu\n",a[1][0],a[1][1]==0,sizeof a); return 0; }