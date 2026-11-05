#include <stdio.h>
static const char *f(void){ return __func__; } int main(void){ printf("%s %s %d %s\n",f(),__FUNCTION__,__LINE__>0,__FILE__[0]?"f":"n"); return 0; }