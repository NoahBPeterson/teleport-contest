#include <stdio.h>
#include <wchar.h>
int main(void){ wchar_t w[]=L"h\x263A"; const wchar_t *p=L"xy"; printf("%zu %d %d %zu %d\n",sizeof w,w[1],p[1],wcslen(w),L'x'); return 0; }