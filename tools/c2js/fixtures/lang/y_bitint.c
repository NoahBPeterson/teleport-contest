#include <stdio.h>
int main(void){ _BitInt(12) a=2047; unsigned _BitInt(7) b=127; b+=1; a+=1; _BitInt(70) c=1; c<<=68; printf("%d %d %d %zu\n",(int)a,(int)b,(int)(c>>66),sizeof c); return 0; }