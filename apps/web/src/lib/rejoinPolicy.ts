/**
 * Run-4 fix (30 s network drop): LiveKit's own reconnect gives up after
 * ~10 attempts (well under 30 s of outage), after which the room was left
 * disconnected and the student sat on "Waiting for teacher screen…" with
 * dead peer connections. The classroom now rejoins by itself: it waits for
 * the network, fetches a FRESH token and mounts a NEW Room (new peer
 * connections), retrying with backoff until it works. The share is then
 * resubscribed by the normal subscription logic.
 */

/** Disconnect reasons (livekit-client DisconnectReason numbers) that must NOT auto-rejoin. */
export const NO_REJOIN_REASONS = {
  CLIENT_INITIATED: 1,
  DUPLICATE_IDENTITY: 2,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
} as const;

export function shouldAutoRejoin(reason: number | undefined, opts: { leaving: boolean }): boolean {
  if (opts.leaving) return false;
  if (reason === undefined) return true;
  return !Object.values(NO_REJOIN_REASONS).includes(reason as 1);
}

/**
 * Backoff for rejoin attempt n (0-based): 1 s, 2 s, 4 s, 8 s, 16 s, then every
 * 30 s, with ±50% jitter. The wide jitter matters at 2,000 students: after a
 * mass drop the rejoins must spread out instead of hitting /token and the SFU
 * in one wave (load test 2026-10-22: reconnect storm).
 */
export function rejoinDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(REJOIN_MAX_DELAY_MS, 1000 * 2 ** Math.min(16, Math.max(0, attempt)));
  const jitter = 0.5 + rand();
  return Math.round(base * jitter);
}
export const REJOIN_MAX_DELAY_MS = 30_000;

/**
 * Backoff after the first LiveKit connect of a mount failed (join ramp:
 * trial 2 had 83 connect timeouts at 1,200–1,400 students while LiveKit ran
 * at 1600–2200% CPU). `failures` counts consecutive failed connects (≥ 1) and
 * is only reset once a connect succeeds, so a student whose retry also fails
 * waits longer each time (2 s, 4 s, 8 s … 45 s) instead of re-hitting the SFU
 * every second. Jitter 50–100% keeps retries from lining up.
 */
export const CONNECT_RETRY_BASE_MS = 2_000;
export const CONNECT_RETRY_MAX_MS = 45_000;
export function connectRetryDelayMs(failures: number, rand: () => number = Math.random): number {
  const f = Math.max(1, Math.floor(failures) || 1);
  const cap = Math.min(CONNECT_RETRY_MAX_MS, CONNECT_RETRY_BASE_MS * 2 ** Math.min(16, f - 1));
  return Math.round(cap * (0.5 + 0.5 * Math.min(1, Math.max(0, rand()))));
}

/**
 * livekit-client ReconnectPolicy: jittered exponential backoff for the SDK's
 * own resume / full-reconnect attempts. The SDK default retries on a fixed
 * schedule, so thousands of clients dropped together retry in lockstep (and
 * collide as "participant with same identity" on the SFU). First retry
 * 0.3–1.5 s, then doubling to 15 s with full jitter; gives up after ~60 s and
 * lets the classroom rejoin with a fresh token (rejoinDelayMs).
 */
export function classroomReconnectPolicy(rand: () => number = Math.random) {
  return {
    nextRetryDelayInMs(ctx: { retryCount: number; elapsedMs: number }): number | null {
      if (ctx.elapsedMs > 60_000 || ctx.retryCount >= 12) return null;
      if (ctx.retryCount === 0) return Math.round(300 + rand() * 1200);
      const cap = Math.min(15_000, 500 * 2 ** ctx.retryCount);
      return Math.round(cap / 2 + rand() * (cap / 2));
    },
  };
}

/**
 * A DUPLICATE_IDENTITY disconnect that arrives while this tab is itself
 * rejoining, or right after it connected, is the SFU evicting our own stale
 * session (the old connection of this same tab), not another device. Ignore it
 * instead of showing "opened on another device".
 */
export function isOwnStaleDuplicate(opts: { rejoining: boolean; connectedAt: number | null; now: number }): boolean {
  if (opts.rejoining) return true;
  return opts.connectedAt != null && opts.now - opts.connectedAt < 15_000;
}

/** A room stuck in Reconnecting/SignalReconnecting this long is torn down and rejoined. */
export const STUCK_RECONNECT_MS = 25_000;

/** HTTP status from /token → what to do. */
export function rejoinOutcome(status: number): 'ok' | 'ended' | 'stop' | 'retry' {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 410) return 'ended';
  if (status === 401 || status === 403 || status === 404) return 'stop';
  return 'retry';
}
