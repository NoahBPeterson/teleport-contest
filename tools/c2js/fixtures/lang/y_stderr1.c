#include <stdio.h>
#include <errno.h>
#include <string.h>
int main(void){ fprintf(stderr,"e\n"); errno=2; printf("%d %s\n",errno,strerror(ENOENT)); FILE *f=fopen("/nonexistent/x","r"); printf("%d %d\n",f==0,errno); perror("x"); return 3; }