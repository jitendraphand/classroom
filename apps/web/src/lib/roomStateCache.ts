/**
 * Short-lived, single-flight memo for the student /state view.
 *
 * In the 1,500-student trial every "state changed" nudge made every student
 * refetch /state at once, and each request recomputed the same ~1,500-row
 * roster (Prisma + ~12 Redis reads), so the web tier returned 503s. Students
 * all see the same roster, so a worker now computes it once per room per
 * version and shares the promise with concurrent requests.
 *
 * Freshness: entries are keyed by a per-room version (Redis `roomver:{code}`)
 * that every nudge / push bumps, and expire after STATE_CACHE_MS (default
 * 1000 ms; 0 disables). The teacher's view is never cached.
 */
import { ensureRedis } from './redis';

type Entry<T> = { exp: number; p: Promise<T> };
const store = new Map<string, Entry<unknown>>();
/**
 * Keys carry the room version, which every nudge bumps, so each bump strands
 * the previous entry (a full ~1,500-row roster). Trial 2: expired entries were
 * only dropped once 2,000 had piled up, so a worker could hold hundreds of MB
 * of dead rosters during the join ramp and hit its heap cap (5 OOM restarts).
 * Expired entries are now swept at most every SWEEP_MS, and the map is small.
 */
const MAX_ENTRIES = 256;
const SWEEP_MS = 1_000;
let lastSweep = 0;

function sweep(now: number) {
  for (const [k, e] of store) if (e.exp <= now) store.delete(k);
  lastSweep = now;
}

export function memoSize() {
  return store.size;
}

export function stateCacheMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.STATE_CACHE_MS ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return 1_000;
  return Math.min(n, 5_000);
}

/** Single-flight memo: concurrent callers share one computation; failures are not cached. */
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>, now = Date.now()): Promise<T> {
  if (ttlMs <= 0) return fn();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.exp > now) return hit.p;
  if (now - lastSweep >= SWEEP_MS || store.size >= MAX_ENTRIES) sweep(now);
  if (store.size >= MAX_ENTRIES) store.clear();
  const p = fn();
  const entry: Entry<T> = { exp: now + ttlMs, p };
  store.set(key, entry);
  p.catch(() => {
    if (store.get(key) === entry) store.delete(key);
  });
  return p;
}

/**
 * The Room row by code, shared for a few seconds (heartbeat, messages): it
 * changes rarely (status/settings), and those routes only need it for access
 * checks. A student's own participant status is still read per request.
 */
export const ROOM_ROW_TTL_MS = 3_000;
export async function roomRowCached(code: string) {
  const { prisma } = await import('./db');
  return memo(`room-row:${code}`, ROOM_ROW_TTL_MS, () => prisma.room.findUnique({ where: { code } }));
}

export function clearStateMemo() {
  store.clear();
  lastSweep = 0;
}

/** Drop one memo entry on this worker (e.g. the room was reopened under a new session id). */
export function forgetMemo(key: string) {
  store.delete(key);
}

export const roomVersionKey = (code: string) => `roomver:${code}`;

/** Current version of a room's state ('0' when unknown or Redis is down: TTL still bounds staleness). */
export async function roomVersion(code: string): Promise<string> {
  try {
    const redis = await ensureRedis();
    return (await redis.get(roomVersionKey(code))) ?? '0';
  } catch {
    return '0';
  }
}

/** Invalidate cached student views of this room on every worker. Fire-and-forget. */
export function bumpRoomVersion(code: string | null | undefined) {
  if (!code) return;
  void (async () => {
    try {
      const redis = await ensureRedis();
      await redis.multi().incr(roomVersionKey(code)).expire(roomVersionKey(code), 86_400).exec();
    } catch {
      /* TTL bounds staleness */
    }
  })();
}
