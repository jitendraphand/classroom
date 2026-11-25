import { ensureRedis, keys } from './redis';

/**
 * Active hidden admin observers per room.
 *
 * Only populated while an admin has /admin/live/[code] open and actively
 * observing (`mode: 'observe'`). Never populated by /admin/live (the overview).
 * Entries auto-expire after OBSERVER_LEASE_MS if the browser disappears without
 * calling unregister, so students never stay stuck publishing cameras.
 */
export const OBSERVER_LEASE_MS = 45_000;
export const OBSERVER_HEARTBEAT_MS = 15_000;
export const OBSERVER_HIDDEN_DISCONNECT_MS = 60_000;
const KEY_TTL_S = 120;

export function isObserverIdentityForAdmin(identity: string, adminId: string): boolean {
  return !!adminId && identity.startsWith(`adminobserver_${adminId}_`) && identity.length <= 128;
}

export function partitionObserverLeases(
  raw: Record<string, string>,
  now = Date.now(),
): { active: string[]; expired: string[] } {
  const active: string[] = [];
  const expired: string[] = [];
  for (const [identity, expRaw] of Object.entries(raw)) {
    const exp = Number(expRaw);
    if (identity.startsWith('adminobserver_') && Number.isFinite(exp) && exp > now) {
      active.push(identity);
    } else {
      expired.push(identity);
    }
  }
  active.sort();
  return { active, expired };
}

export async function registerObserver(
  code: string,
  identity: string,
  now = Date.now(),
): Promise<{ activeCount: number; transitionedToActive: boolean }> {
  const redis = await ensureRedis();
  const hkey = keys.observers(code);
  const mkey = keys.observerMarker(code);
  await redis
    .multi()
    .hset(hkey, identity, String(now + OBSERVER_LEASE_MS))
    .expire(hkey, KEY_TTL_S)
    .exec();
  const raw = (await redis.hgetall(hkey)) ?? {};
  const { active, expired } = partitionObserverLeases(raw, now);
  if (expired.length) await redis.hdel(hkey, ...expired).catch(() => undefined);
  const setRes = await redis.set(mkey, '1', 'EX', KEY_TTL_S, 'NX');
  if (setRes !== 'OK') await redis.expire(mkey, KEY_TTL_S).catch(() => undefined);
  return { activeCount: active.length, transitionedToActive: setRes === 'OK' };
}

export async function refreshObserver(
  code: string,
  identity: string,
  now = Date.now(),
): Promise<{ activeCount: number; transitionedToActive: boolean }> {
  return registerObserver(code, identity, now);
}

export async function unregisterObserver(
  code: string,
  identity: string,
  now = Date.now(),
): Promise<{ activeCount: number; transitionedToInactive: boolean }> {
  const redis = await ensureRedis();
  const hkey = keys.observers(code);
  const mkey = keys.observerMarker(code);
  await redis.hdel(hkey, identity);
  const raw = (await redis.hgetall(hkey)) ?? {};
  const { active, expired } = partitionObserverLeases(raw, now);
  if (expired.length) await redis.hdel(hkey, ...expired).catch(() => undefined);
  if (active.length === 0) {
    const deleted = await redis.del(mkey);
    return { activeCount: 0, transitionedToInactive: deleted > 0 };
  }
  return { activeCount: active.length, transitionedToInactive: false };
}

export async function listActiveObservers(
  code: string,
  now = Date.now(),
): Promise<{ observers: string[]; transitionedToInactive: boolean }> {
  const redis = await ensureRedis();
  const hkey = keys.observers(code);
  const mkey = keys.observerMarker(code);
  const raw = (await redis.hgetall(hkey)) ?? {};
  const { active, expired } = partitionObserverLeases(raw, now);
  if (expired.length) await redis.hdel(hkey, ...expired).catch(() => undefined);
  if (active.length === 0) {
    const deleted = await redis.del(mkey);
    return { observers: [], transitionedToInactive: deleted > 0 };
  }
  return { observers: active, transitionedToInactive: false };
}

export async function hasActiveObserver(code: string, now = Date.now()): Promise<boolean> {
  try {
    const { observers } = await listActiveObservers(code, now);
    return observers.length > 0;
  } catch {
    return false;
  }
}
