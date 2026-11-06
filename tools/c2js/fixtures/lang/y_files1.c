#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void){ char n[]="/tmp/c2jsXXXXXX"; int fd=mkstemp(n); close(fd); FILE *f=fopen(n,"w"); fprintf(f,"ab %d\ncd\n",5); fputs("ef",f); fclose(f); f=fopen(n,"r"); char b[16]; fgets(b,16,f); int c=fgetc(f); ungetc(c,f); printf("%s%c %ld\n",b,fgetc(f),ftell(f)); fseek(f,0,SEEK_END); printf("%ld\n",ftell(f)); rewind(f); char r[4]; size_t got=fread(r,1,3,f); r[got]=0; int x; fscanf(f,"%d",&x); printf("%s %d %d\n",r,x,feof(f)); fclose(f); f=fopen(n,"a"); fwrite("zz",1,2,f); fclose(f); f=fopen(n,"rb"); fseek(f,-2,SEEK_END); printf("%c\n",fgetc(f)); fclose(f); remove(n); printf("%d\n",fopen(n,"r")==0); return 0; }