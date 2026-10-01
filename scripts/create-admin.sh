#!/usr/bin/env bash
# Create the single school admin, or reset its password.
#
#   ./scripts/create-admin.sh                      # create from ADMIN_EMAIL in .env (no-op if an admin exists)
#   ./scripts/create-admin.sh --email a@school.org # create with this email
#   ./scripts/create-admin.sh --reset-password     # lost admin password: generate a new one
#   ./scripts/create-admin.sh --status             # does an admin exist?
#   add --print to show the password once on this console instead of writing the file
#
# The generated password is written to ./secrets/admin-initial-password
# (directory mode 700, owned by the web container user uid 1001, file mode
# 600): readable by root on the host, not by other users, never committed.
# Read it with:  sudo cat secrets/admin-initial-password
# Sign in at /login, change it (forced), then delete the file.
set -euo pipefail
cd "$(dirname "$0")/.."

cmd=create
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset-password) cmd=reset-password; extra+=(--yes-reset-admin-password) ;;
    --status) cmd=status ;;
    --email) extra+=(--email "$2"); shift ;;
    --email=*) extra+=(--email "${1#--email=}") ;;
    --print) extra+=(--print) ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -f .env ]]; then
  echo "No .env here. Run ./scripts/sync-livekit-keys.sh (or a configure-*.sh script) first." >&2
  exit 1
fi

# Secrets directory the container (uid 1001) can write but other host users cannot read.
install -d -m 700 secrets
if [[ "$(id -u)" == "0" ]]; then
  chown 1001:1001 secrets
elif [[ "$(stat -c %u secrets 2>/dev/null || echo)" != "1001" ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo chown 1001:1001 secrets
  else
    echo "Note: run 'sudo chown 1001:1001 secrets' so the container can write the password file;" >&2
    echo "      otherwise the password is printed once on this console instead." >&2
  fi
fi

docker compose up -d postgres redis >/dev/null
if [[ -n "$(docker compose ps -q --status running web 2>/dev/null)" ]]; then
  docker compose exec -T web node scripts/admin.mjs "$cmd" ${extra[@]+"${extra[@]}"}
else
  # Runs the normal entrypoint (secret checks, migrations) and then the command.
  docker compose run --rm --no-deps -T web node scripts/admin.mjs "$cmd" ${extra[@]+"${extra[@]}"}
fi

if [[ "$cmd" != "status" && -e secrets/admin-initial-password ]]; then
  echo
  echo "Password file: secrets/admin-initial-password (read: sudo cat secrets/admin-initial-password)."
  echo "Sign in at \$APP_URL/login, change the password when asked, then delete the file."
fi
