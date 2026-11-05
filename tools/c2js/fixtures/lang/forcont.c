#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){int i,s=0;for(i=0;i<5;i++){switch(i){case 1:continue;case 2:break;default:s+=10;}s+=1;}do{s--;if(s>30)continue;break;}while(1);while(i-->0)if(i==2)break;printf("%d %d\n",s,i);return 0;}
