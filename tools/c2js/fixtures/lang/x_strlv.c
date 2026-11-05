#include <stdio.h>
int main(void){ printf("%c %c %c %zu\n","abc"[1],*"xyz",*("xyz"+2),sizeof "abc"); const char (*p)[4]=&"abc"; printf("%s\n",*p); return 0; }