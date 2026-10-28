/**
 * Short per-resource mutex for read-modify-write of a Redis value from
 * several web workers (e.g. the mic queue). SET NX PX with a random token,
 * compare-and-delete release (LOCK_RELEASE_LUA). WATCH/MULTI is not an option:
 * every request shares one ioredis connection, and WATCH is per connection.
 */
import { LOCK_RELEASE_LUA, newLockToken } from './leaderLock';
import { ensureRedis } from './redis';

export class LockBusyError extends Error {
  constructor(key: string) {
    super(`busy: ${key}`);
    this.name = 'LockBusyError';
  }
}

export async function withRedisLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number } = {}
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 5_000;
  const deadline = Date.now() + (opts.waitMs ?? 3_000);
  const redis = await ensureRedis();
  const token = newLockToken();
  let delay = 10;
  while ((await redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') {
    if (Date.now() >= deadline) throw new LockBusyError(key);
    await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * delay)));
    delay = Math.min(delay * 2, 100);
  }
  try {
    return await fn();
  } finally {
    await redis.eval(LOCK_RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
