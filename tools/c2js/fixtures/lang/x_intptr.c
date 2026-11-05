#include <stdio.h>
#include <stdint.h>
int main(void){ int a[2]={1,2}; intptr_t i=(intptr_t)a; int *p=(int*)(i+4); uintptr_t u=(uintptr_t)p; printf("%d %d %d\n",*p,(int)(u-i),(int)(u&3)); return 0; }