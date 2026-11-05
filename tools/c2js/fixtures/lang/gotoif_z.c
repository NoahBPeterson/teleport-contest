#define _FORTIFY_SOURCE 0
#include <stdio.h>
static int f(int x){int r=0;if(x)goto in;if(r==0){r=1;in:r+=10;}return r;}static int g(int x){int r=0;switch(x){case 1:r=1;if(0){case 2:r=2;}r+=5;break;}return r;}int main(void){printf("%d %d %d %d\n",f(0),f(1),g(1),g(2));return 0;}
