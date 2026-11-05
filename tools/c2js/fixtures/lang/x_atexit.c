#include <stdio.h>
#include <stdlib.h>
static void a(void){ printf("a\n"); } static void b(void){ printf("b\n"); } int main(void){ atexit(a); atexit(b); printf("m\n"); return 0; }