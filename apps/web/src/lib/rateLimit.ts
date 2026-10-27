import { ensureRedis } from './redis';
import { clientIpFrom } from './clientIp';

/**
 * Fixed-window login throttle in Redis. Counts FAILED attempts per account and
 * per client IP; a success clears the account counter. Fails open (logs) when
 * Redis is unreachable so an outage does not lock every user out.
 */
const WINDOW_S = 15 * 60;
const MAX_PER_ACCOUNT = 8;
const MAX_PER_IP = 40;

const accountKey = (email: string) => `ratelimit:login:acct:${email.toLowerCase()}`;
const ipKey = (ip: string) => `ratelimit:login:ip:${ip}`;

/** The client's IP; X-Forwarded-For only counts from a trusted proxy (lib/clientIp). */
export function clientIp(req: Request): string {
  return clientIpFrom(req.headers);
}

/** Seconds until retry, or 0 when the attempt may proceed. */
export async function loginBlockedFor(email: string, ip: string): Promise<number> {
  try {
    const redis = await ensureRedis();
    const [a, i] = await Promise.all([redis.get(accountKey(email)), redis.get(ipKey(ip))]);
    if (Number(a || 0) >= MAX_PER_ACCOUNT) return Math.max(1, await redis.ttl(accountKey(email)));
    if (Number(i || 0) >= MAX_PER_IP) return Math.max(1, await redis.ttl(ipKey(ip)));
    return 0;
  } catch (e) {
    console.warn('[rate-limit] unavailable, allowing login attempt', e instanceof Error ? e.message : e);
    return 0;
  }
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  try {
    const redis = await ensureRedis();
    const pipe = redis.multi();
    pipe.incr(accountKey(email));
    pipe.expire(accountKey(email), WINDOW_S, 'NX');
    pipe.incr(ipKey(ip));
    pipe.expire(ipKey(ip), WINDOW_S, 'NX');
    await pipe.exec();
  } catch {
    /* fail open */
  }
}

export async function clearLoginFailures(email: string): Promise<void> {
  try {
    const redis = await ensureRedis();
    await redis.del(accountKey(email));
  } catch {
    /* ignore */
  }
}

/**
 * Generic fixed window: true when `key` went over `limit` hits in `windowS`.
 * Fails open (Redis down = allowed).
 */
export async function overRateLimit(key: string, limit: number, windowS: number): Promise<boolean> {
  if (limit <= 0) return false;
  try {
    const redis = await ensureRedis();
    const [[, n]] = (await redis.multi().incr(key).expire(key, windowS, 'NX').exec()) as [[unknown, number]];
    return Number(n) > limit;
  } catch {
    return false;
  }
}
