#!/usr/bin/env bash
# Wire .env for a bare public-IP deploy (no domain).
# Usage:
#   PUBLIC_IP=203.0.113.10 ./scripts/configure-public-ip.sh
#   PUBLIC_IP=203.0.113.10 APP_PORT=3000 LIVEKIT_PORT=7880 ./scripts/configure-public-ip.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ -z "${PUBLIC_IP:-}" ]]; then
  echo "Usage: PUBLIC_IP=<vps-public-ip> $0" >&2
  echo "Example: PUBLIC_IP=203.0.113.10 $0" >&2
  exit 1
fi

APP_PORT="${APP_PORT:-3000}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
SCHEME="${SCHEME:-http}"   # use https / wss only when TLS terminates in front
WS_SCHEME="ws"
if [[ "$SCHEME" == "https" ]]; then
  WS_SCHEME="wss"
fi

APP_URL_VAL="${SCHEME}://${PUBLIC_IP}:${APP_PORT}"
LK_URL="${WS_SCHEME}://${PUBLIC_IP}:${LIVEKIT_PORT}"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "Created $ENV_FILE from .env.example"
fi

# Fresh random LiveKit key/secret, NEXTAUTH_SECRET and POSTGRES_PASSWORD whenever
# the current value is missing, a placeholder or known to have leaked. Written
# to the untracked .env only; never printed.
# shellcheck source=lib/secrets.sh
source "$ROOT/scripts/lib/secrets.sh"
ensure_env_secrets "$ENV_FILE"

upsert() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {$0=k"="v} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

upsert APP_URL "$APP_URL_VAL"
upsert NEXT_PUBLIC_APP_URL "$APP_URL_VAL"
upsert NEXT_PUBLIC_LIVEKIT_URL "$LK_URL"
# Server→LiveKit stays on loopback (host networking)
upsert LIVEKIT_URL "ws://127.0.0.1:${LIVEKIT_PORT}"
upsert LIVEKIT_INTERNAL_URL "http://127.0.0.1:${LIVEKIT_PORT}"
upsert LIVEKIT_USE_EXTERNAL_IP "true"
upsert LIVEKIT_NODE_IP "$PUBLIC_IP"
if [[ "$SCHEME" == "https" ]]; then
  upsert COOKIE_SECURE "true"
else
  upsert COOKIE_SECURE "false"
fi

echo "Updated .env for public IP ${PUBLIC_IP}:"
echo "  APP_URL=${APP_URL_VAL}"
echo "  NEXT_PUBLIC_LIVEKIT_URL=${LK_URL}"
echo "  LIVEKIT_USE_EXTERNAL_IP=true"
echo "  LIVEKIT_NODE_IP=${PUBLIC_IP}"
echo
echo "Next:"
echo "  ./scripts/sync-livekit-keys.sh"
echo "  docker compose up --build -d"
