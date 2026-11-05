#include <stdio.h>
#include <stdint.h>
static int g=1,h=2;
static uint16_t us=5; static int8_t sc=-1; static uint64_t u6=7; static int arr[3]={10,20,30}; static int idx=0;
static int setg(int v){ g=v; return 1; }
static int bumpi(void){ idx++; return 100; }
static uint16_t setus(void){ us=9; return 2; }
static int8_t setsc(void){ sc=3; return 4; }
static uint64_t setu6(void){ u6=40; return 2; }
int main(void){
 g|=setg(8); printf("%d\n",g);
 g=1; g+=setg(8); printf("%d\n",g);
 int *p=&h; *p+=(h=5,1); printf("%d\n",h);
 us+=setus(); printf("%d\n",us);
 sc|=setsc(); printf("%d\n",sc);
 u6*=setu6(); printf("%llu\n",(unsigned long long)u6);
 arr[idx]=bumpi(); printf("%d %d %d\n",arr[0],arr[1],idx);
 arr[idx]+=bumpi(); printf("%d %d %d\n",arr[1],arr[2],idx);
 g=1; int r=g+setg(5)+g; printf("%d\n",r);
 g=1; int q=(setg(2),g)-g; printf("%d\n",q);
 int a=1; a=a++ + 0; printf("%d\n",a);
 return 0; }
