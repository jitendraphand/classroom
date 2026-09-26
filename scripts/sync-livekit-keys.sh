#!/usr/bin/env bash
# Sync LIVEKIT_* from .env into infra/livekit.yaml (keys + RTC public-IP settings).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

USE_EXT="${LIVEKIT_USE_EXTERNAL_IP:-false}"
# Auto-enable external IP when APP_URL / NEXT_PUBLIC_APP_URL points at a non-loopback host
APP="${APP_URL:-${NEXT_PUBLIC_APP_URL:-}}"
if [[ "$USE_EXT" != "true" && -n "$APP" ]]; then
  case "$APP" in
    *localhost*|*127.0.0.1*|*::1*) ;;
    http://*|https://*) USE_EXT=true ;;
  esac
fi

NODE_IP_BLOCK=""
if [[ -n "${LIVEKIT_NODE_IP:-}" ]]; then
  NODE_IP_BLOCK=$'\n'"  node_ip: ${LIVEKIT_NODE_IP}"
fi

cat > "$ROOT/infra/livekit.yaml" << YAML
port: 7880
bind_addresses:
  - 0.0.0.0
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: ${USE_EXT}${NODE_IP_BLOCK}
redis:
  address: 127.0.0.1:6379
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
logging:
  level: info
room:
  auto_create: true
  empty_timeout: 300
  max_participants: 200
YAML

echo "Synced LiveKit keys into infra/livekit.yaml (use_external_ip=${USE_EXT}${LIVEKIT_NODE_IP:+, node_ip=${LIVEKIT_NODE_IP}})"
