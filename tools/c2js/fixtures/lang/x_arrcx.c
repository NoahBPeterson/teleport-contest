#include <stdio.h>
#include <complex.h>
int main(void){ double complex a[2]={1+2*I,3}; a[1]*=a[0]; printf("%f %f %zu\n",creal(a[1]),cimag(a[1]),sizeof a); float complex f=1; f+=I; printf("%f\n",cimagf(f)); return 0; }