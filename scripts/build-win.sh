#!/bin/sh
# Produce a Windows installer and a portable exe when Wine and NSIS are available.
# Otherwise build the helper and the JS bundle, then print the Windows commands.
set -eu
cd "$(dirname "$0")/.."

bash scripts/build-helper.sh
npm run build

# The JS bundle lives in dist/. Do not point electron-builder at dist/ or its
# clean step deletes main.js. Installers are built in release/, then copied.
rm -f dist/ClassroomTeacher-setup.exe dist/ClassroomTeacher-portable.exe dist/ClassroomTeacher-setup.exe.blockmap

if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
  # Wine cannot commit rcedit's resource update. signAndEditExecutable stays
  # on. This directory is first on PATH so the rcedit call is applied with
  # resedit; NSIS and every other wine command still reach /usr/bin/wine.
  root="$(pwd)"
  shim_dir="$root/.wine-shim"
  mkdir -p "$shim_dir"
  cat > "$shim_dir/wine" << EOF
#!/bin/sh
for a in "\$@"; do
  case "\$a" in
    *rcedit-ia32.exe|*rcedit-x64.exe|*rcedit.exe)
      exec node "$root/scripts/rcedit-shim.mjs" "\$@"
      ;;
  esac
done
exec /usr/bin/wine "\$@"
EOF
  chmod +x "$shim_dir/wine"
  PATH="$shim_dir:$PATH"
  export PATH
  npx electron-builder --win nsis portable
  cp -f release/ClassroomTeacher-setup.exe release/ClassroomTeacher-portable.exe dist/
  ls -l dist/ClassroomTeacher-setup.exe dist/ClassroomTeacher-portable.exe
  echo "Installers are in dist/ and release/"
  exit 0
fi

cat <<'EOF'

Wine is not installed, so the Windows installer was not packaged on this machine.
The app bundle and native/affinity-helper.exe are ready.

On a Windows PC, from this directory:

  npm ci
  scripts\build-helper.sh
  npm run build
  npx electron-builder --win nsis portable

Or, if Git bash is unavailable, compile the helper with MSYS2 gcc (see scripts/build-helper.sh)
and run the same npm commands in PowerShell. Output: release\ClassroomTeacher-setup.exe and
release\ClassroomTeacher-portable.exe. Nothing is signed (no certificate is configured).

EOF
