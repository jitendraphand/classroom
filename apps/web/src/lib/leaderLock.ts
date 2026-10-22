/**
 * Redis SET NX locks so jobs that must run once (rank snapshots, teacher-absence
 * confirm) do not run on every web worker. Fails closed (returns null) when
 * Redis is unreachable: the next tick retries.
 */
import { randomBytes } from 'node:crypto';
import { ensureRedis } from './redis';

/** Compare-and-delete so we never drop another worker's lock after expiry+reuse. */
export const LOCK_RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function newLockToken(): string {
  return randomBytes(16).toString('hex');
}

export async function acquireLock(key: string, ttlS: number): Promise<string | null> {
  const token = newLockToken();
  try {
    const redis = await ensureRedis();
    const ok = await redis.set(key, token, 'EX', Math.max(1, ttlS), 'NX');
    return ok === 'OK' ? token : null;
  } catch (e) {
    console.warn('[lock] acquire failed', key, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    const redis = await ensureRedis();
    await redis.eval(LOCK_RELEASE_LUA, 1, key, token);
  } catch {
    /* expiry will drop it */
  }
}

/** Run `fn` only if this process wins the lock. */
export async function runIfLeader<T>(key: string, ttlS: number, fn: () => Promise<T>): Promise<T | undefined> {
  const token = await acquireLock(key, ttlS);
  if (!token) return;
  try {
    return await fn();
  } finally {
    await releaseLock(key, token);
  }
}
