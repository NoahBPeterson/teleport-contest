#include <stdio.h>
int main(void){ __fp16 h=1.5; _Float16 g=2.5f; float f=h; printf("%f %f %zu\n",(double)f,(double)g,sizeof g); return 0; }