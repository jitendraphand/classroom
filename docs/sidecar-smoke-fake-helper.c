#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <windows.h>
#include <fcntl.h>
#include <io.h>
int main(){ _setmode(_fileno(stdout), _O_BINARY);
 fprintf(stderr,"{\"event\":\"ready\",\"width\":640,\"height\":360}\n"); fflush(stderr);
 int w=640,h=360; uint32_t hd[5]={0x31434757,w,h,w*4,w*h*4}; uint8_t*b=malloc(w*h*4);
 for(int f=0;f<200;f++){ for(int i=0;i<w*h;i++){b[i*4]=(f*5)&255;b[i*4+1]=100;b[i*4+2]=200;b[i*4+3]=255;}
  if(fwrite(hd,4,5,stdout)!=5)break; if(fwrite(b,1,w*h*4,stdout)!=(size_t)w*h*4)break; fflush(stdout); Sleep(100);} return 0;}
