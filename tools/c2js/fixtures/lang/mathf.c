#include <stdio.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <time.h>
static int cmpi(const void *a,const void *b){ return *(int*)a-*(int*)b; }
int main(void){ double d=2.5; float f=2.5f; int e; double ip;
 printf("%f %f %f %f %f\n",frexp(8.0,&e),ldexp(1.5,3),modf(3.75,&ip),ip,(double)e);
 printf("%f %f %f %f %f %f\n",copysign(3,-1),fmax(1,2),fmin(1,2),fdim(5,3),fma(2,3,4),hypot(3,4));
 printf("%f %f %f %f %f %f\n",round(2.5),round(-2.5),trunc(-2.7),rint(2.5),nearbyint(3.5),cbrt(27));
 printf("%ld %ld %lld %lld\n",lround(2.5),lrint(2.5),llround(-3.5),llrint(3.5));
 printf("%f %f %f %f %f\n",log1p(0),expm1(0),log2(8),exp2(3),logb(8));
 printf("%f %f %f %f %f %f\n",acosh(1),asinh(0),atanh(0),erf(0),erfc(0),tgamma(5)); printf("%f %f %d %f\n",lgamma(1),remainder(7,2),ilogb(8),scalbn(1.5,2)); printf("%.17g\n",nextafter(1.0,2.0));
 printf("%f %f %f %f %f %f %f\n",sinf(f),cosf(f),sqrtf(f),powf(f,2),fabsf(-f),floorf(f),ceilf(f)); printf("%f %f %f %f %f\n",roundf(f),truncf(f),fmodf(f,2),fminf(f,1),fmaxf(f,1)); printf("%.10f %.10f %.10f\n",(double)logf(f),(double)expf(f),(double)tanf(f));
 printf("%d %d %d %d %d %d\n",isnan(NAN)!=0,isinf(INFINITY)!=0,isfinite(d)!=0,isnormal(d)!=0,signbit(-d)!=0,fpclassify(0.0)==FP_ZERO); printf("%d %d %d %d\n",isnan(f)!=0,isinf(f)!=0,isfinite(f)!=0,signbit(-f)!=0);
 char b[32]; strcpy(b,"Hello"); printf("%zu %s %s %s\n",strnlen(b,3),strpbrk(b,"lo"),strndup(b,2),stpcpy(b+5,"X")-1); printf("%zu %zu %s\n",strspn("aab","a"),strcspn("aab","b"),(char*)memchr(b,'l',5)); char s1[16]="a,b"; char *sp=s1; printf("%s ",strsep(&sp,",")); printf("%s\n",sp); printf("%d %d %d\n",isblank(' ')!=0,isupper('a')!=0,tolower('Q')); printf("%lld %llu %f %f\n",atoll("-9"),strtoull("99",0,10),strtof("1.5",0),strtod("2.5x",0));
 int a[4]={4,3,2,1}; qsort(a,4,4,cmpi); int key=3; int *fd=bsearch(&key,a,4,4,cmpi); printf("%d\n",(int)(fd-a)); printf("%d %ld %lld\n",abs(-3),labs(-4L),llabs(-5LL)); srand(1); int r1=rand(); printf("%d\n",r1>=0); 
 struct tm t; memset(&t,0,sizeof t); t.tm_year=100; t.tm_mon=1; t.tm_mday=2; t.tm_hour=3; char tb[64]; strftime(tb,64,"%Y-%m-%d %H:%M %j %a %b",&t); printf("%s\n",tb); time_t tt=86400; struct tm *g=gmtime(&tt); printf("%d %d\n",g->tm_mday,g->tm_year); 
 FILE *fp=stdout; fputc('c',fp); putc('d',fp); fputs("e\n",fp); fprintf(fp,"%d\n",1); printf("%d %d\n",feof(fp)!=0,ferror(fp)!=0); printf("%d %d %d\n",__builtin_popcount(255),__builtin_clz(1),__builtin_ctzll(8ULL)); printf("%x %llx %d\n",__builtin_bswap32(0x11223344),__builtin_bswap64(1ULL),__builtin_expect(3,3));
 return 0; }
