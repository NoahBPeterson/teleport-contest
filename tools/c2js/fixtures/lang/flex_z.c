#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdlib.h>
struct F{int n;char d[];};int main(void){struct F *f=malloc(sizeof(struct F)+4);f->n=3;strcpy(f->d,"xy");printf("%d %s %zu\n",f->n,f->d,sizeof(struct F));free(f);return 0;}
