#include <stdio.h>
static int d[3]={1,2,3}; static int (*f(void))[3]{ return &d; } static int (*(*g(void))(void))[3]{ return f; } int main(void){ printf("%d %d\n",(*f())[1],(*g()())[2]); return 0; }