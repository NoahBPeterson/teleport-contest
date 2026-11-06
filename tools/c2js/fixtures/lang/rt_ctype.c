#include <stdio.h>
#include <ctype.h>
int main(void){
  for(int c=-1;c<256;c++)
    printf("%d a%d n%d l%d u%d d%d x%d s%d p%d g%d P%d c%d b%d t%d T%d\n",c,!!isalpha(c),!!isalnum(c),!!islower(c),!!isupper(c),!!isdigit(c),!!isxdigit(c),!!isspace(c),!!isprint(c),!!isgraph(c),!!ispunct(c),!!iscntrl(c),!!isblank(c),tolower(c),toupper(c));
  return 0;}
