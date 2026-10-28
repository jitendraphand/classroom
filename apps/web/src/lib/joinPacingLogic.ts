/**
 * Join-wave pacing (pure, unit-tested in tests/joinPacing.test.ts).
 *
 * In the 1,500-student trial everyone connected to LiveKit within seconds and
 * 411 clients hit publish NegotiationError timeouts. The token route now hands
 * each student a connect slot from a shared leaky bucket (JOIN_CONNECT_RATE
 * per second, at most JOIN_SPREAD_MAX_MS ahead) and the client waits that long
 * before connecting. A publish that still times out is retried quickly.
 */

/** Students per second admitted to the SFU when a wave arrives. */
export function joinConnectRate(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.JOIN_CONNECT_RATE);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : DEFAULT_JOIN_CONNECT_RATE;
}

/**
 * Trial 2 (1,500 students, 32 OCPU): at 40/s within a fixed 15 s window,
 * everyone past ~600 landed in the same window and LiveKit hit 1600–2200% CPU
 * with 83 connect timeouts at 1,200–1,400 students. Defaults are now 30/s and
 * the window grows with the room (roomSize / rate), up to JOIN_SPREAD_CAP_MS.
 */
export const DEFAULT_JOIN_CONNECT_RATE = 30;
export const DEFAULT_JOIN_SPREAD_MAX_MS = 15_000;
export const DEFAULT_JOIN_SPREAD_CAP_MS = 90_000;
export const JOIN_SPREAD_HARD_CAP_MS = 180_000;

/** Upper bound for the room-size-scaled window (ms). */
export function joinSpreadCapMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.JOIN_SPREAD_CAP_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, JOIN_SPREAD_HARD_CAP_MS) : DEFAULT_JOIN_SPREAD_CAP_MS;
}

/**
 * The pacing window for a room of `roomSize` students: at least
 * JOIN_SPREAD_MAX_MS, else long enough for the whole room at JOIN_CONNECT_RATE
 * (roomSize / rate seconds), capped at JOIN_SPREAD_CAP_MS. 0 when pacing is off.
 */
export function joinSpreadForRoom(roomSize: number, env: Record<string, string | undefined> = process.env): number {
  const base = joinSpreadMaxMs(env);
  if (base <= 0) return 0;
  const size = Number.isFinite(roomSize) && roomSize > 0 ? roomSize : 0;
  const scaled = Math.ceil((size / joinConnectRate(env)) * 1000);
  return Math.max(base, Math.min(Math.max(base, joinSpreadCapMs(env)), scaled));
}

/** The longest a student is asked to wait before connecting. 0 disables pacing. */
export function joinSpreadMaxMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.JOIN_SPREAD_MAX_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60_000) : DEFAULT_JOIN_SPREAD_MAX_MS;
}

/**
 * Leaky-bucket virtual clock: `next` is when the next slot is free. Returns
 * this caller's delay and the new `next`. Delay never exceeds `maxMs` (a wave
 * larger than rate × max all lands inside the window, just denser).
 */
export function paceSlot(now: number, next: number, gapMs: number, maxMs: number): { delay: number; next: number } {
  const slot = Math.max(now, next);
  const delay = Math.min(slot - now, maxMs);
  return { delay, next: now + delay + gapMs };
}

/** Same rule, atomically in Redis (KEYS[1]=clock; ARGV=now, gap, max). */
export const PACE_LUA = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local nxt = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nxt)
local delay = math.min(slot - now, max)
redis.call('SET', KEYS[1], tostring(now + delay + gap), 'PX', math.floor(max + gap + 5000))
return delay
`;

/** Client side: the wait before connecting, clamped (bad / old server → 0). */
export function clientConnectDelayMs(body: unknown): number {
  const v = (body as { connectDelayMs?: unknown } | null)?.connectDelayMs;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.round(v), JOIN_SPREAD_HARD_CAP_MS);
}

/** LiveKit publish / connect failures that a quick retry usually fixes. */
export function isNegotiationError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = String((e as { name?: unknown }).name ?? '');
  const msg = String((e as { message?: unknown }).message ?? '');
  return name === 'NegotiationError' || /negotiat|timed out|timeout/i.test(msg);
}

/** Retry a publish on a negotiation timeout: up to `retries` more tries, 0.5–1.5 s apart. */
export async function withNegotiationRetry<T>(
  run: () => Promise<T>,
  opts: {
    retries?: number;
    beforeRetry?: () => Promise<void> | void;
    shouldContinue?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    rnd?: () => number;
  } = {}
): Promise<T> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rnd = opts.rnd ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= retries || !isNegotiationError(e) || (opts.shouldContinue && !opts.shouldContinue())) throw e;
      console.warn('LiveKit publish negotiation failed, retrying', attempt + 1);
      try {
        await opts.beforeRetry?.();
      } catch {
        /* nothing published */
      }
      await sleep(500 + Math.floor(1000 * rnd()));
      if (opts.shouldContinue && !opts.shouldContinue()) throw e;
    }
  }
}
