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

/** Backoff for rejoin attempt n (0-based): 1 s, 2 s, 4 s, 8 s, then every 10 s, with ±20% jitter. */
export function rejoinDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(10_000, 1000 * 2 ** Math.max(0, attempt));
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return Math.round(base * jitter);
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
