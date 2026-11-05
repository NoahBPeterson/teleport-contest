#include <stdio.h>
#include <stdlib.h>
static void a(void){ printf("x\n"); } static void d(void){ atexit(a); exit(0); } int main(void){ d(); printf("no\n"); return 0; }