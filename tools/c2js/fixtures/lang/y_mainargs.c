#include <stdio.h>
int main(int argc,char **argv,char **envp){ printf("%d %d %d\n",argc,argv[argc]==0,argv[0]!=0); return 0; }