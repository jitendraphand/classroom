import { ensureRedis } from './redis';
import { DB_VERSION_KEY } from './dbCacheVersion';

/**
 * Redis read-through cache for hot Prisma reads (room state polls). Keys are
 * versioned by the global write counter, so any write anywhere invalidates
 * every entry; TTL bounds memory. Dates survive the JSON round trip.
 */
export const DB_CACHE_TTL_S = 60;
let hits = 0;
let misses = 0;

const DATE = '__d';
function replacer(this: Record<string, unknown>, key: string, value: unknown) {
  const raw = this[key];
  return raw instanceof Date ? { [DATE]: raw.toISOString() } : value;
}
function reviver(_key: string, value: unknown) {
  if (value && typeof value === 'object' && DATE in (value as object) && Object.keys(value as object).length === 1) {
    return new Date((value as Record<string, string>)[DATE]!);
  }
  return value;
}
export const encodeCached = (v: unknown) => JSON.stringify({ v }, replacer);
export const decodeCached = <T>(s: string): T => (JSON.parse(s, reviver) as { v: T }).v;

export async function cachedRead<T>(key: string, fn: () => Promise<T>, ttlS = DB_CACHE_TTL_S): Promise<T> {
  let redis: Awaited<ReturnType<typeof ensureRedis>> | null = null;
  let k = '';
  try {
    redis = await ensureRedis();
    const ver = (await redis.get(DB_VERSION_KEY)) ?? '0';
    k = `dbcache:${ver}:${key}`;
    const hit = await redis.get(k);
    if (hit !== null) {
      hits++;
      return decodeCached<T>(hit);
    }
  } catch {
    redis = null;
  }
  misses++;
  const v = await fn();
  if (redis && k) {
    try {
      await redis.set(k, encodeCached(v), 'EX', ttlS);
    } catch {
      /* ignore */
    }
  }
  return v;
}

export function dbCacheStats() {
  return { hits, misses };
}
