#include <stdio.h>
#include <wchar.h>
int main(void){ wchar_t a[8]=L"ab"; wchar_t b[4]; wcscpy(b,L"cd"); wcscat(a,b); printf("%zu %d %d %d\n",wcslen(a),a[3],wcscmp(a,L"abcd"),*wcschr(a,'c')); return 0; }