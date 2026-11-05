#define _FORTIFY_SOURCE 0
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
int main(void){unsigned long long u=1ULL<<63;long long s=-1;int sh=4;unsigned char c=0xF0;printf("%llu %lld %d %d %llu\n",u>>sh,s>>sh,c>>sh,(signed char)c>>sh,(unsigned long long)s>>60);return 0;}
