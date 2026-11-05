#define _FORTIFY_SOURCE 0
#include <stdio.h>
int main(void){char *n[]={"one","two"};char **q=n;q++;printf("%s\n",*q);return 0;}
