#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){int s=0;int i;for(i=0;i<5;i++){if(i==1)continue;if(i==3)goto done;s+=i;}done:;while(s<10){s+=3;if(s==6)goto skip;s+=1;skip:;}printf("%d %d\n",s,i);return 0;}
