#include <stdio.h>
#include <wchar.h>
#include <stddef.h>
#include <stdint.h>
int main(void){ printf("[%*d][%-*d][%.*f][%#o][%#X][%+.2e][%G][%a][%5c][%-5c][%lc][%ls]\n",4,1,4,2,2,3.14159,8,255,1234.5,1e-10,1.0,'a','b',L'c',L"wd"); printf("[%hhu][%hd][%lx][%llo][%zx][%td][%jd][%Lf][%p][%n]\n",257,65537,255L,8LL,(size_t)255,(ptrdiff_t)-1,(intmax_t)7,1.5L,(void*)0,(int[1]){0}); printf("%5%|%s|%.3s|%10.3s|%c%c\n","x","abcdef","abcdef",65,66); return 0; }