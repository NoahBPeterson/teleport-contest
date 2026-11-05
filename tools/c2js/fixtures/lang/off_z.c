#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
struct S{char a;int b;short c[4];};int main(void){printf("%zu %zu %zu\n",(size_t)&((struct S*)0)->b,(size_t)&((struct S*)0)->c[2],offsetof(struct S,c));return 0;}
