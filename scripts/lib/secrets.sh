#!/usr/bin/env bash
# Shared helpers: make sure .env holds real, freshly generated secrets.
#
# Sourced by configure-public-ip.sh, configure-domain-tls.sh (and thus
# configure-sslip-tls.sh) and sync-livekit-keys.sh. Secrets are only ever
# written to the untracked .env (and, by sync-livekit-keys.sh, the untracked
# infra/livekit.yaml). Nothing is printed except the variable NAMES that were
# generated.
#
# A value is replaced when it is missing, a documented placeholder, the old
# `devkey` API key, or a value that is known to have leaked through public git
# history (compared by SHA-256 so the leaked value itself is not in this repo).

# SHA-256 of values that were committed to the public repository. Never reuse.
#   - LiveKit API secret from the initial commit's infra/livekit.yaml
#   - POSTGRES_PASSWORD from early .env history (classroom_dev_password)
LEAKED_SECRET_SHA256=(
  8c672724f5fe8ec105a9a97bf37d9f36e891891bde4d082f26d9478ba7128bc3
  2a8915bd005c7ae07faa331d2700c50ae29f58dc3e506dfbd77bb19b232acc36
)

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf %s "$1" | sha256sum | cut -c1-64
  else
    printf %s "$1" | shasum -a 256 | cut -c1-64
  fi
}

_rand_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# is_leaked_value VALUE → 0 when VALUE is in LEAKED_SECRET_SHA256
is_leaked_value() {
  local h
  h="$(_sha256 "$1")"
  local x
  for x in "${LEAKED_SECRET_SHA256[@]}"; do
    [[ "$h" == "$x" ]] && return 0
  done
  return 1
}

# is_weak_value NAME VALUE → 0 when VALUE must be replaced
is_weak_value() {
  local name="$1" val="$2"
  [[ -z "$val" ]] && return 0
  case "$val" in
    change-me*|replace-with*|replace-me*|placeholder*|changeme*|secret|password) return 0 ;;
  esac
  if [[ "$name" == "LIVEKIT_API_KEY" ]]; then
    [[ "$val" == "devkey" || "$val" == "APIxxxxxxxx" ]] && return 0
    return 1
  fi
  is_leaked_value "$val" && return 0
  # Secrets must be long enough to resist offline guessing.
  [[ "${#val}" -lt 24 ]] && return 0
  return 1
}

_env_get() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2-
}

_env_set() {
  local file="$1" key="$2" val="$3"
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {$0=k"="v} {print}' "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
  chmod 600 "$file" 2>/dev/null || true
}

# ensure_env_secrets ENV_FILE
#   Replace weak/leaked LIVEKIT_API_KEY, LIVEKIT_API_SECRET, NEXTAUTH_SECRET and
#   POSTGRES_PASSWORD with fresh random values (and keep DATABASE_URL in sync).
#   Set ROTATE_SECRETS=1 to force-regenerate all of them.
ensure_env_secrets() {
  local file="$1"
  local generated=()
  local cur

  cur="$(_env_get "$file" LIVEKIT_API_KEY)"
  if [[ "${ROTATE_SECRETS:-0}" == "1" ]] || is_weak_value LIVEKIT_API_KEY "$cur"; then
    _env_set "$file" LIVEKIT_API_KEY "API$(_rand_hex 8)"
    generated+=(LIVEKIT_API_KEY)
  fi

  cur="$(_env_get "$file" LIVEKIT_API_SECRET)"
  if [[ "${ROTATE_SECRETS:-0}" == "1" ]] || is_weak_value LIVEKIT_API_SECRET "$cur"; then
    _env_set "$file" LIVEKIT_API_SECRET "$(_rand_hex 32)"
    generated+=(LIVEKIT_API_SECRET)
  fi

  cur="$(_env_get "$file" NEXTAUTH_SECRET)"
  if [[ "${ROTATE_SECRETS:-0}" == "1" ]] || is_weak_value NEXTAUTH_SECRET "$cur"; then
    _env_set "$file" NEXTAUTH_SECRET "$(_rand_hex 32)"
    generated+=(NEXTAUTH_SECRET)
  fi

  cur="$(_env_get "$file" POSTGRES_PASSWORD)"
  if [[ "${ROTATE_SECRETS:-0}" == "1" ]] || is_weak_value POSTGRES_PASSWORD "$cur"; then
    local pw user db
    pw="$(_rand_hex 24)"
    user="$(_env_get "$file" POSTGRES_USER)"; user="${user:-classroom}"
    db="$(_env_get "$file" POSTGRES_DB)"; db="${db:-classroom}"
    _env_set "$file" POSTGRES_PASSWORD "$pw"
    _env_set "$file" DATABASE_URL "postgresql://${user}:${pw}@127.0.0.1:5432/${db}"
    generated+=(POSTGRES_PASSWORD)
  fi

  if [[ "${#generated[@]}" -gt 0 ]]; then
    echo "Generated fresh values in $(basename "$file") for: ${generated[*]} (not printed)."
    if [[ " ${generated[*]} " == *" POSTGRES_PASSWORD "* ]]; then
      echo "  NOTE: an EXISTING Postgres volume keeps its old password. Either run" >&2
      echo "        ALTER USER ... PASSWORD inside the container, or recreate the volume." >&2
    fi
  fi
}

# assert_env_secrets ENV_FILE → exit 1 (without printing values) if any secret is weak.
assert_env_secrets() {
  local file="$1" bad=() key
  for key in LIVEKIT_API_KEY LIVEKIT_API_SECRET NEXTAUTH_SECRET POSTGRES_PASSWORD; do
    if is_weak_value "$key" "$(_env_get "$file" "$key")"; then
      bad+=("$key")
    fi
  done
  if [[ "${#bad[@]}" -gt 0 ]]; then
    echo "Refusing to continue: ${bad[*]} in $(basename "$file") is missing, a placeholder, or a known-leaked value." >&2
    echo "Run ./scripts/sync-livekit-keys.sh (it generates fresh values), or set them yourself." >&2
    return 1
  fi
}
