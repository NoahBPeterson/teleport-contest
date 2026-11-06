#include <stdio.h>
static int f(void){ return 1; } int main(void){ int a=f(); { int f=5; a+=f; } struct f{int f;} v={2}; a+=v.f; printf("%d\n",a); return 0; }