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
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 40;
}

/** The longest a student is asked to wait before connecting. 0 disables pacing. */
export function joinSpreadMaxMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.JOIN_SPREAD_MAX_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60_000) : 15_000;
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
  return Math.min(Math.round(v), 20_000);
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
