#include <stdio.h>
int main(void){ int t=0; for(struct{int a;int b;}s={0,3};s.a<s.b;s.a++) t+=s.a; for(int i=0,a[2]={5,6};i<2;i++) t+=a[i]; printf("%d\n",t); return 0; }