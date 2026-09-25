#!/bin/sh
set -e
echo "[classroom] Waiting for Postgres at DATABASE_URL host..."
node <<'NODE'
const net = require('net');
const url = process.env.DATABASE_URL || '';
const m = url.match(/@([^:/]+):(\d+)/);
const host = m ? m[1] : '127.0.0.1';
const port = m ? Number(m[2]) : 5432;
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
    if (await tryOnce()) {
      console.log('[classroom] Postgres is reachable');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error('[classroom] Postgres not reachable');
  process.exit(1);
})();
NODE

echo "[classroom] Running prisma migrate deploy..."
npx prisma migrate deploy || npx prisma db push --accept-data-loss
echo "[classroom] Starting Next.js..."
exec node server.js
