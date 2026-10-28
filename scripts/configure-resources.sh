#!/usr/bin/env bash
# Size the stack for THIS machine and write the values into .env.
#
#   ./scripts/configure-resources.sh                 # detect CPU + RAM
#   EGRESS_MBPS=200 EXPECTED_STUDENTS=300 ./scripts/configure-resources.sh
#   RESOURCE_PROFILE=small ./scripts/configure-resources.sh --print   # dry run
#
# Profiles (auto from the host unless RESOURCE_PROFILE is set):
#   small   ≤ 3 GB RAM or ≤ 2 vCPU  (a 2–4 GB VPS running everything)
#   medium  ≤ 16 GB RAM and ≤ 8 vCPU
#   large   bigger boxes (the defaults in docs/CAPACITY.md)
#
# What it sets (only keys it owns; everything else in .env is left alone):
#   web workers, Prisma pool, Postgres memory/connections, Redis maxmemory,
#   container memory limits for Postgres / Redis / web / Caddy (never for
#   LiveKit: the media server is the one service that must not be OOM-killed
#   mid-class), MEDIA_PROFILE (low on small boxes or when the uplink is short),
#   and log rotation. Re-run after resizing the VM; then
#   `docker compose up -d --force-recreate`.
#
# See docs/CONSTRAINED-DEPLOY.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
PRINT_ONLY=0
[[ "${1:-}" == "--print" ]] && PRINT_ONLY=1

if [[ "$PRINT_ONLY" == 0 && ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "Created .env from .env.example"
fi

# ---------------------------------------------------------------- detect
cpus="${CPUS:-$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}"
if [[ -n "${RAM_MB:-}" ]]; then
  ram_mb="$RAM_MB"
else
  ram_mb=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 2048)
fi

profile="${RESOURCE_PROFILE:-auto}"
if [[ "$profile" == "auto" ]]; then
  if (( ram_mb <= 3200 || cpus <= 2 )); then profile=small
  elif (( ram_mb <= 16384 && cpus <= 8 )); then profile=medium
  else profile=large
  fi
fi
if (( ram_mb < 1800 )); then
  echo "WARNING: ${ram_mb} MB RAM is below the 2 GB minimum for web + Postgres + Redis + LiveKit on one box." >&2
fi

clamp() { local v=$1 lo=$2 hi=$3; (( v < lo )) && v=$lo; (( v > hi )) && v=$hi; echo "$v"; }

# ---------------------------------------------------------------- size
case "$profile" in
  small)
    web_workers=$(( ram_mb < 2600 ? 1 : (cpus >= 2 ? 2 : 1) ))
    db_pool=5
    pg_shared=$(clamp $(( ram_mb / 16 )) 64 256)
    pg_cache=$(clamp $(( ram_mb / 4 )) 256 1024)
    pg_maint=32
    pg_work=4
    redis_max=$(( ram_mb < 2600 ? 96 : 128 ))
    web_limit=$(( web_workers * (ram_mb < 2600 ? 600 : 640) ))
    pg_limit=$(clamp $(( ram_mb / 5 )) 320 768)
    caddy_limit=128
    media_default=low
    log_size=5m
    ;;
  medium)
    # One worker per core, as long as each gets ~450 MB of a 35 % share of RAM.
    by_ram=$(( ram_mb * 35 / 100 / 450 ))
    web_workers=$(clamp "$cpus" 1 "$(clamp "$by_ram" 1 8)")
    db_pool=8
    pg_shared=$(clamp $(( ram_mb / 16 )) 128 1024)
    pg_cache=$(clamp $(( ram_mb / 4 )) 512 4096)
    pg_maint=$(clamp $(( ram_mb / 64 )) 64 256)
    pg_work=8
    redis_max=256
    web_limit=$(( web_workers * 600 ))
    pg_limit=$(clamp $(( ram_mb / 5 )) 768 3072)
    caddy_limit=256
    media_default=standard
    log_size=10m
    ;;
  large)
    web_workers=auto
    db_pool=auto
    pg_shared=$(clamp $(( ram_mb / 8 )) 1024 8192)
    pg_cache=$(clamp $(( ram_mb * 3 / 4 )) 4096 49152)
    pg_maint=512
    pg_work=16
    redis_max=1024
    web_limit=0
    pg_limit=0
    caddy_limit=0
    media_default=standard
    log_size=20m
    ;;
  *)
    echo "RESOURCE_PROFILE must be small, medium, large or auto" >&2
    exit 1
    ;;
esac

if [[ "$web_workers" == auto ]]; then
  pg_max=400
else
  # Every worker's pool, plus headroom for migrate / psql / the attendance flush.
  pg_max=$(( web_workers * db_pool + 24 ))
fi
redis_limit=$(( redis_max == 1024 ? 0 : redis_max + 96 ))

# Egress: the SFU forwards the teacher's streams to every student, so the
# uplink, not the CPU, usually decides how many students fit. Per-student
# downstream from the server (docs/BANDWIDTH.md, docs/CONSTRAINED-DEPLOY.md):
#   standard ≈ 0.9 Mbps (slides + teacher camera), low ≈ 0.4 Mbps.
media="${MEDIA_PROFILE_OVERRIDE:-$media_default}"
if [[ -n "${EGRESS_MBPS:-}" ]]; then
  usable=$(( EGRESS_MBPS * 80 / 100 ))
  fit_std=$(( usable * 10 / 9 ))
  fit_low=$(( usable * 10 / 4 ))
  echo "Uplink ${EGRESS_MBPS} Mbps (80% usable): about ${fit_std} students at MEDIA_PROFILE=standard, ${fit_low} at low."
  if [[ -n "${EXPECTED_STUDENTS:-}" && -z "${MEDIA_PROFILE_OVERRIDE:-}" ]]; then
    if (( EXPECTED_STUDENTS > fit_std )); then media=low; else media=standard; fi
    if (( EXPECTED_STUDENTS > fit_low )); then
      echo "WARNING: ${EXPECTED_STUDENTS} students need more uplink than ${EGRESS_MBPS} Mbps even at MEDIA_PROFILE=low; add a media node (docs/MULTI-SERVER.md) or ask students to use 'Audio + share only'." >&2
    fi
  fi
fi

mb() { (( $1 == 0 )) && echo 0 || echo "${1}m"; }

declare -a KV=(
  "RESOURCE_PROFILE_APPLIED=$profile"
  "WEB_WORKERS=$web_workers"
  "DB_POOL_PER_WORKER=$db_pool"
  "POSTGRES_MAX_CONNECTIONS=$pg_max"
  "POSTGRES_SHARED_BUFFERS=${pg_shared}MB"
  "POSTGRES_EFFECTIVE_CACHE_SIZE=${pg_cache}MB"
  "POSTGRES_MAINTENANCE_WORK_MEM=${pg_maint}MB"
  "POSTGRES_WORK_MEM=${pg_work}MB"
  "POSTGRES_SHM_SIZE=$(( pg_shared < 128 ? 128 : pg_shared ))mb"
  "REDIS_MAXMEMORY=${redis_max}mb"
  "POSTGRES_MEM_LIMIT=$(mb "$pg_limit")"
  "REDIS_MEM_LIMIT=$(mb "$redis_limit")"
  "WEB_MEM_LIMIT=$(mb "$web_limit")"
  "CADDY_MEM_LIMIT=$(mb "$caddy_limit")"
  "MEDIA_PROFILE=$media"
  "LOG_MAX_SIZE=$log_size"
  "LOG_MAX_FILES=3"
)

echo "Host: ${cpus} vCPU, ${ram_mb} MB RAM → profile ${profile}"
for kv in "${KV[@]}"; do echo "  $kv"; done
if [[ "$PRINT_ONLY" == 1 ]]; then
  echo "(dry run: .env not changed)"
  exit 0
fi

# shellcheck source=lib/secrets.sh
source "$ROOT/scripts/lib/secrets.sh"
for kv in "${KV[@]}"; do _env_set "$ENV_FILE" "${kv%%=*}" "${kv#*=}"; done
echo "Wrote these to $(basename "$ENV_FILE"). Apply with: docker compose up -d --force-recreate"
