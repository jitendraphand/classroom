#!/bin/sh
set -eu

# Exit cleanly on SIGTERM/SIGINT so Docker's stop grace period is honoured
# instead of the container being SIGKILLed mid-migration (which is what left
# half-applied migrations in _prisma_migrations).
trap 'exit 143' TERM INT

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
