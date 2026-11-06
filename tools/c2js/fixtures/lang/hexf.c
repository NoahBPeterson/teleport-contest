#include <stdio.h>
int main(void){ double v[]={0,1,1.5,-2.75,0.1,1e308,5e-324,1e-310,3.14159}; for(int i=0;i<9;i++) printf("%a %A %.2a %.0a %#.0a %20a %-20a| %.14a\n",v[i],v[i],v[i],v[i],v[i],v[i],v[i],v[i]); printf("%f %a %a\n",1.0/0,1.0/0,-1.0/0); return 0; }
