#include <stdio.h>
static char ca[]={1,[3]=4,5}; static const char *ps[4]={[2]="two"}; static unsigned char ub[6]={[1]=200,[4]=9}; static short sa[4]={[2]=3};
static char *pz[]={"a",[2]="c"}; static _Bool bs[3]={[2]=1};
int main(void){ char l[5]={[1]='x',[3]='y'}; char s2[3][4]={[1]="ab"}; static char st[4]={[2]=7}; const char *lp[3]={[1]="q"};
printf("%zu %d %d %d %d %d %d %s %s\n",sizeof ca,ca[0],ca[1],ca[3],ca[4],ub[1],ub[4],ps[2],ps[0]?"x":"null");
printf("%d %d %s %d %s %d %d %d %d %s %s\n",sa[2],bs[2],pz[2],(int)(sizeof pz/8),s2[1],s2[0][0],l[1],l[3],st[2],lp[1],lp[0]?"x":"null");
return 0; }
