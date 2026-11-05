#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
static int d(int count){int n=(count+3)/4,c=0;switch(count%4){case 0:do{c+=1;case 3:c+=10;case 2:c+=100;case 1:c+=1000;}while(--n>0);}return c;}int main(void){int i;for(i=0;i<9;i++)printf("%d ",d(i));printf("\n");return 0;}
