#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
int main(void){int x=1,y=0;switch(x)case 1:y=2;printf("%d\n",y);return 0;}
