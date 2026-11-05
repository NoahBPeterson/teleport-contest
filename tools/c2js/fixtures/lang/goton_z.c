#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int f(int n){int i=0,s=0;for(i=0;i<n;i++){for(int j=0;j<n;j++){if(j==2)goto next;s+=j;}s+=100;next:s+=1000;}return s;}static int h(int n){int s=0;goto start;again:s++;start:if(s<n)goto again;return s;}static int w(int x){int i=0;do{if(x)goto lab;i+=1;x=1;continue;lab:i+=10;x=0;}while(i<30);return i;}int main(void){printf("%d %d %d\n",f(3),h(4),w(0));return 0;}
