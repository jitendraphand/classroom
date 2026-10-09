#!/bin/sh
# Cross-compile the Win32 display-affinity helper. The .exe is a build output.
set -eu
cd "$(dirname "$0")/.."
out="native/affinity-helper.exe"
src="native/affinity-helper.c"
if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  x86_64-w64-mingw32-windres -O coff -o native/helper-res.o native/helper.rc
  x86_64-w64-mingw32-gcc -O2 -s -static-libgcc -Wall -o "$out" "$src" native/helper-res.o -ld3d11 -ldxgi -lole32 -luser32 -lgdi32
elif command -v gcc >/dev/null 2>&1 && gcc -dumpmachine 2>/dev/null | grep -q mingw; then
  windres -O coff -o native/helper-res.o native/helper.rc
  gcc -O2 -s -static-libgcc -Wall -o "$out" "$src" native/helper-res.o -ld3d11 -ldxgi -lole32 -luser32 -lgdi32
else
  echo "No mingw gcc found."
  echo "Linux:  sudo apt-get install gcc-mingw-w64-x86-64"
  echo "        x86_64-w64-mingw32-gcc -O2 -s -static-libgcc -o native/affinity-helper.exe native/affinity-helper.c -ld3d11 -ldxgi -lole32 -luser32 -lgdi32"
  echo "Windows (MSYS2): gcc -O2 -s -static-libgcc -o native/affinity-helper.exe native/affinity-helper.c -ld3d11 -ldxgi -lole32 -luser32 -lgdi32"
  exit 1
fi
echo "built $out"
