import { ensureRedis } from './redis';

/**
 * Global data version for the Redis read cache (lib/dbCache). Bumped after
 * every Prisma write, and once more 2 s later so a write inside an
 * interactive transaction (bumped before its commit) cannot leave a
 * pre-commit read cached under the new version.
 */
export const DB_VERSION_KEY = 'dbcache:version';
let queries = 0;

export function noteDbQuery() {
  queries++;
}
export function dbQueryCount() {
  return queries;
}

async function bump() {
  try {
    const r = await ensureRedis();
    await r.incr(DB_VERSION_KEY);
  } catch {
    /* Redis down: cache reads fail open to the DB */
  }
}

export function noteDbWrite() {
  void bump();
  setTimeout(() => void bump(), 2000).unref?.();
}
