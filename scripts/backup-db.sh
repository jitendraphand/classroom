#!/usr/bin/env bash
# Back up the classroom database (attendance, students, timetable, staff).
#
#   ./scripts/backup-db.sh                 # dump to ./backups, keep the newest 14
#   ./scripts/backup-db.sh --keep 30       # keep the newest 30 dumps
#   ./scripts/backup-db.sh --restore FILE  # restore a dump into the running database (asks first)
#
# Nightly, as root on the host (crontab -e):
#   17 2 * * * cd /path/to/classroom && ./scripts/backup-db.sh >> /var/log/classroom-backup.log 2>&1
#
# A copy on the same disk does not survive losing the server. Set
# BACKUP_COPY_CMD in the environment (for example on the cron line, not in
# .env, which Docker Compose also reads) to copy each new dump off the box:
#   BACKUP_COPY_CMD='rclone copy "$1" remote:classroom-backups' ./scripts/backup-db.sh
#   BACKUP_COPY_CMD='scp "$1" backup@203.0.113.5:classroom/' ./scripts/backup-db.sh
# ($1 is the new dump's path). Test a restore into a scratch server now and then.
#
# Dumps use pg_dump's custom format (-Fc: compressed, restorable table by table).
# The ./backups directory is mode 700 and gitignored.
set -euo pipefail
cd "$(dirname "$0")/.."

keep=14
restore=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) keep="$2"; shift ;;
    --keep=*) keep="${1#--keep=}" ;;
    --restore) restore="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! "$keep" =~ ^[0-9]+$ ]] || [[ "$keep" -lt 1 ]]; then
  echo "--keep needs a whole number of at least 1." >&2
  exit 2
fi

env_value() {
  # Read one KEY=value from .env without sourcing it (values may hold shell characters).
  [[ -f .env ]] || return 0
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

pg_user="$(env_value POSTGRES_USER)"
pg_db="$(env_value POSTGRES_DB)"
pg_user="${pg_user:-classroom}"
pg_db="${pg_db:-classroom}"

if ! docker compose ps --status running postgres 2>/dev/null | grep -q postgres; then
  echo "The postgres service is not running (docker compose up -d postgres)." >&2
  exit 1
fi

if [[ -n "$restore" ]]; then
  [[ -f "$restore" ]] || { echo "No such file: $restore" >&2; exit 1; }
  echo "This REPLACES the data in database '$pg_db' with $restore."
  echo "Stop the web service first (docker compose stop web) so nothing writes meanwhile."
  read -r -p "Type the database name to continue: " answer
  [[ "$answer" == "$pg_db" ]] || { echo "Cancelled."; exit 1; }
  docker compose exec -T postgres pg_restore -U "$pg_user" -d "$pg_db" --clean --if-exists --no-owner < "$restore"
  echo "Restored. Start the web service again: docker compose up -d web"
  exit 0
fi

install -d -m 700 backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/classroom-${stamp}.dump"
tmp="${out}.partial"
trap 'rm -f "$tmp"' EXIT

docker compose exec -T postgres pg_dump -U "$pg_user" -d "$pg_db" -Fc > "$tmp"
# A dump that is empty or not in custom format means pg_dump failed.
if [[ ! -s "$tmp" ]] || [[ "$(head -c 5 "$tmp")" != "PGDMP" ]]; then
  echo "pg_dump produced no valid dump; nothing kept." >&2
  exit 1
fi
mv "$tmp" "$out"
chmod 600 "$out"
echo "Backup written: $out ($(du -h "$out" | cut -f1))"

# Keep the newest $keep dumps.
mapfile -t old < <(ls -1t backups/classroom-*.dump 2>/dev/null | tail -n +"$((keep + 1))")
for f in "${old[@]}"; do
  rm -f -- "$f"
done

copy_cmd="${BACKUP_COPY_CMD:-}"
if [[ -n "$copy_cmd" ]]; then
  if bash -c "$copy_cmd" _ "$out"; then
    echo "Copied off the server: $out"
  else
    echo "WARNING: BACKUP_COPY_CMD failed; the dump is only on this server." >&2
    exit 1
  fi
else
  echo "Note: BACKUP_COPY_CMD is not set, so this dump is only on this server." >&2
fi
