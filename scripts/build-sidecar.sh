#!/bin/sh
# Cross-compile the native screen-share sidecar (LiveKit Rust SDK) for Windows x64.
# Needs rustup (target x86_64-pc-windows-msvc), cargo-xwin, clang + lld.
# Missing toolchain → no sidecar; the app then publishes from Electron (fallback).
set -eu
cd "$(dirname "$0")/.."
PATH="$HOME/.cargo/bin:$PATH"
export PATH
if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "cargo-xwin not found: skipping share-sidecar.exe (Electron publish fallback only)."
  exit 0
fi
(cd native/share-sidecar && cargo xwin build --release --target x86_64-pc-windows-msvc)
cp -f native/share-sidecar/target/x86_64-pc-windows-msvc/release/share-sidecar.exe native/share-sidecar.exe
echo "built native/share-sidecar.exe"
