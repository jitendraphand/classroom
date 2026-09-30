#!/bin/sh
set -eu

# Exit cleanly on SIGTERM/SIGINT so Docker's stop grace period is honoured
# instead of the container being SIGKILLed mid-migration (which is what left
# half-applied migrations in _prisma_migrations).
trap 'exit 143' TERM INT

# Refuse to boot with placeholder or publicly leaked secrets. The LiveKit
# key/secret pair is an admin credential for the SFU, and one pair was once
# committed to this public repo (compared by SHA-256 here, never stored).
# Run ./scripts/sync-livekit-keys.sh on the host to generate fresh values.
node -e "
const crypto = require('crypto');
const leaked = new Set([
  '8c672724f5fe8ec105a9a97bf37d9f36e891891bde4d082f26d9478ba7128bc3',
  '2a8915bd005c7ae07faa331d2700c50ae29f58dc3e506dfbd77bb19b232acc36',
]);
const weak = (name, v, minLen) => {
  if (!v) return 'missing';
  if (/^(change-?me|replace-with|replace-me|placeholder)/i.test(v)) return 'a placeholder';
  if (name === 'LIVEKIT_API_KEY' && v === 'devkey') return 'the old devkey';
  if (leaked.has(crypto.createHash('sha256').update(v).digest('hex'))) return 'a known-leaked value';
  if (minLen && v.length < minLen) return 'too short';
  return '';
};
const bad = [
  ['LIVEKIT_API_KEY', 0],
  ['LIVEKIT_API_SECRET', 32],
  ['NEXTAUTH_SECRET', 32],
]
  .map(([k, n]) => [k, weak(k, process.env[k] || '', n)])
  .filter(([, why]) => why);
if (bad.length) {
  for (const [k, why] of bad) console.error('[classroom] FATAL: ' + k + ' is ' + why + '.');
  console.error('[classroom] Run ./scripts/sync-livekit-keys.sh on the host (generates fresh values into .env), then recreate livekit and web.');
  process.exit(1);
}
"

# Parse the DB host/port properly. The previous regex mis-parsed any password
# containing '@' and could not read IPv6 or URL-encoded credentials.
DB_HOST=$(node -e "
try { console.log(new URL(process.env.DATABASE_URL || '').hostname || '127.0.0.1'); }
catch { console.log('127.0.0.1'); }
")
DB_PORT=$(node -e "
try { console.log(new URL(process.env.DATABASE_URL || '').port || '5432'); }
catch { console.log('5432'); }
")

echo "[classroom] Waiting for Postgres at $DB_HOST:$DB_PORT..."
node -e "
const net = require('net');
const host = process.argv[1];
const port = Number(process.argv[2]);
function tryOnce() {
  return new Promise((resolve) => {
    const s = net.connect(port, host, () => { s.end(); resolve(true); });
    s.setTimeout(2000);
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}
(async () => {
  for (let i = 0; i < 60; i++) {
    if (await tryOnce()) { console.log('[classroom] Postgres is reachable'); process.exit(0); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error('[classroom] Postgres not reachable');
  process.exit(1);
})();
" "$DB_HOST" "$DB_PORT"

echo "[classroom] Running prisma migrate deploy..."
# Fail closed. The previous `|| prisma db push --accept-data-loss` turned a
# transient DB error into an unattended destructive schema sync on every boot,
# and was in practice the normal code path because an earlier migration failed
# to parse. A failed migration must stop the container, not rewrite the schema.
if ! npx prisma migrate deploy; then
  echo "[classroom] FATAL: prisma migrate deploy failed. Refusing to start; the database was left untouched." >&2
  echo "[classroom] Fix the migration, or resolve the failed entry manually:" >&2
  echo "[classroom]   npx prisma migrate resolve --applied  <migration>" >&2
  echo "[classroom]   npx prisma migrate resolve --rolled-back <migration>" >&2
  exit 1
fi

echo "[classroom] Starting Next.js..."
# Allow `docker compose run --rm web <cmd>` to execute that command instead of
# silently starting the production server. The base image's CMD is inherited, so
# an explicit override previously could not reach the process at all.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node server.js
