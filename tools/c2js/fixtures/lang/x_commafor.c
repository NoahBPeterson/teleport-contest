#include <stdio.h>
int main(void){ int i,j,t=0; for(i=0,j=5;i<j;i++,j--) t+=i*j; do { t++; if(t>0) continue; t=0; } while(t<0); while(t>100) t--; int k=(t++,t--,t); printf("%d %d\n",t,k); return 0; }