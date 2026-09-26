#!/usr/bin/env bash
# HTTPS via Caddy + Let's Encrypt using sslip.io (no custom domain).
# Hyphenated IP hostnames resolve to that IP, e.g.:
#   81.223.254.76  →  https://81-223-254-76.sslip.io
#   LiveKit WSS    →  wss://livekit.81-223-254-76.sslip.io
#
# Usage:
#   PUBLIC_IP=81.223.254.76 ./scripts/configure-sslip-tls.sh
#   PUBLIC_IP=81.223.254.76 ACME_EMAIL=you@example.com ./scripts/configure-sslip-tls.sh
#
# Also supports nip.io: SSLIP_BASE=nip.io PUBLIC_IP=… ./scripts/configure-sslip-tls.sh
# (nip.io form: 81.223.254.76.nip.io — we still use hyphen form for sslip.io default)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${PUBLIC_IP:-}" ]]; then
  echo "Usage: PUBLIC_IP=<vps-public-ipv4> $0" >&2
  echo "Example: PUBLIC_IP=81.223.254.76 ACME_EMAIL=admin@example.com $0" >&2
  echo >&2
  echo "Creates DOMAIN like 81-223-254-76.sslip.io for Caddy + Let's Encrypt." >&2
  exit 1
fi

# Basic IPv4 check
if [[ ! "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "PUBLIC_IP must be an IPv4 address (got: $PUBLIC_IP)" >&2
  exit 1
fi

BASE="${SSLIP_BASE:-sslip.io}"
HYPHEN_IP="${PUBLIC_IP//./-}"

if [[ "$BASE" == "nip.io" || "$BASE" == "sslip.io" ]]; then
  # sslip.io: 81-223-254-76.sslip.io
  # nip.io accepts dotted: 81.223.254.76.nip.io — hyphen also often works; use dotted for nip.io
  if [[ "$BASE" == "nip.io" ]]; then
    DOMAIN="${PUBLIC_IP}.nip.io"
  else
    DOMAIN="${HYPHEN_IP}.sslip.io"
  fi
else
  DOMAIN="${HYPHEN_IP}.${BASE}"
fi

export DOMAIN PUBLIC_IP
export ACME_EMAIL="${ACME_EMAIL:-}"
export LIVEKIT_HOST="${LIVEKIT_HOST:-livekit.${DOMAIN}}"

echo "Using free DNS hostname (no registrar needed):"
echo "  App:     https://${DOMAIN}"
echo "  LiveKit: wss://${LIVEKIT_HOST}"
echo "  Resolves to PUBLIC_IP=${PUBLIC_IP}"
echo

# Quick resolver check (non-fatal)
if command -v getent >/dev/null 2>&1; then
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [[ -n "$resolved" && "$resolved" != "$PUBLIC_IP" ]]; then
    echo "Warning: $DOMAIN currently resolves to $resolved (expected $PUBLIC_IP)." >&2
    echo "  sslip.io/nip.io should match; check PUBLIC_IP or try again shortly." >&2
  elif [[ -n "$resolved" ]]; then
    echo "DNS OK: $DOMAIN → $resolved"
  fi
fi

exec "$ROOT/scripts/configure-domain-tls.sh"
