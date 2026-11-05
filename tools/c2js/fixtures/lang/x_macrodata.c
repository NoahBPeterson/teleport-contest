#include <stdio.h>

#define A(x) #x
#define C(a,b) a##b
int main(void){ int xy=3; printf("%s %d\n",A(hello),C(x,y)); return 0; }