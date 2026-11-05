#include <stdio.h>
int f(int a){ int s=0,i=0;
 goto mid;
top: s+=1;
mid: for(i=0;i<3;i++){ if(a==1&&i==1) goto out; if(a==2) goto inner; s+=2; inner: s+=3; switch(i){case 0: s+=7; goto cont; case 1: if(a==3) goto top2; break; default: s*=2;} cont:; }
 if(a==4){a=0; goto top;}
 return s;
top2: a=0; s+=100; goto top;
out: switch(s){ case 3: s=50; goto last; default: s=60; }
 for(i=0;i<2;i++){ last: s+=i; }
 return s; }
int main(void){ for(int a=0;a<6;a++) printf("%d ",f(a)); puts(""); return 0;}
