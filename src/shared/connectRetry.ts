/** First-connect retry for the teacher app: fresh token each try, growing backoff with jitter. */
export const CONNECT_RETRY_NOTICE = 'Connecting to the class… retrying.';
export const CONNECT_RETRY_BASE_MS = [1500, 4000, 9000];

/** Delay before retry `attempt + 1`, or null when out of retries. */
export function connectRetryDelayMs(attempt: number, rand: () => number = Math.random): number | null {
  const base = CONNECT_RETRY_BASE_MS[attempt];
  if (base === undefined) return null;
  return Math.round(base * (0.8 + 0.4 * rand()));
}
