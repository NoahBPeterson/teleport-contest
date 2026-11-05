#include <stdio.h>
int f(void){return 7;} int main(void){ int (*a)(void)=&f; int (*b)(void)=*f; int (*c)(void)=**&f; printf("%d %d %d %d\n",a(),b(),c(),a==b); return 0; }