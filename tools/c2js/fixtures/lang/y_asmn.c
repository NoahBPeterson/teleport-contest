#include <stdio.h>
int main(void){ int x=1; __asm__(""); __asm__ __volatile__(""); printf("%d\n",x); return 0; }