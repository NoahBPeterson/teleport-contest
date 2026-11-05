#include <stdio.h>
struct s{int a,b;}; int main(void){ struct s *p=&(struct s){1,2}; int *q=&(int){5}; p->b+=*q; int *r=(int[]){7,8}; printf("%d %d %d\n",p->b,*q,r[1]); return 0; }