#include <stdio.h>
struct s{int s;}; typedef struct s s; int main(void){ s s={3}; struct s *p=&s; enum{e=4}; union u{int u;} u={5}; printf("%d %d %d %d\n",s.s,p->s,e,u.u); return 0; }