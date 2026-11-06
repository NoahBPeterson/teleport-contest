#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#define NEL(a) ((int)(sizeof(a)/sizeof((a)[0])))
static const char *sv[]={"","a","b","abc","abd","ab","abcabc","ABC","\xff","\x80z","a\xff","hello world","  sp ","aaa","%d","a\tb"};
static int sg(int x){return x;}
int main(void){
 for(int i=0;i<NEL(sv);i++)for(int j=0;j<NEL(sv);j++){
  const char*a=sv[i],*b=sv[j];
  printf("%d %d cmp=%d coll=%d",i,j,sg(strcmp(a,b)),sg(strcoll(a,b)));
  for(int n=0;n<5;n++)printf(" n%d=%d",n,sg(strncmp(a,b,n)));
  int m=(strlen(a)<strlen(b)?strlen(a):strlen(b))+1;printf(" mem=%d",sg(memcmp(a,b,m)));
  const char*p=strstr(a,b);printf(" str=%d",p?(int)(p-a):-1);
  p=strpbrk(a,b);printf(" pbrk=%d spn=%d cspn=%d",p?(int)(p-a):-1,(int)strspn(a,b),(int)strcspn(a,b));
  printf(" lcase=%d\n",strcasecmp(a,b));
 }
 for(int i=0;i<NEL(sv);i++)for(int c=0;c<256;c+=17){const char*a=sv[i];const char*p=strchr(a,c),*q=strrchr(a,c);const void*r=memchr(a,c,strlen(a)+1);printf("%d %d %d %d %d\n",i,c,p?(int)(p-a):-1,q?(int)(q-a):-1,r?(int)((const char*)r-a):-1);}
 printf("%d %d\n",strchr("abc",256+'a')?1:0,strrchr("abc",-256+'b')?1:0);
 char b[32];
 for(int n=0;n<10;n++){memset(b,'#',31);b[31]=0;strncpy(b,"abc",n);printf("ncpy %d:",n);for(int z=0;z<10;z++)printf("%02x",(unsigned char)b[z]);printf("\n");
   memset(b,'#',31);b[31]=0;strcpy(b,"xy");strncat(b,"abc",n);printf("ncat %d:",n);for(int z=0;z<10;z++)printf("%02x",(unsigned char)b[z]);printf("\n");}
 char o[16];strcpy(o,"0123456789");memmove(o+2,o,5);printf("%s\n",o);strcpy(o,"0123456789");memmove(o,o+2,5);printf("%s\n",o);
 strcpy(o,"0123456789");memmove(o+1,o,0);printf("%s\n",o);
 memset(o,300,3);printf("%d\n",o[0]);bzero(o,2);printf("%d %d\n",o[0],o[2]);
 printf("%s %s\n",strerror(0),strerror(2));
 printf("%d\n",(int)strlen("a\0b"));
 return 0;}
