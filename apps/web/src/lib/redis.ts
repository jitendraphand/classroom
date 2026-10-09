import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as { redis?: Redis };

function createRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  client.on('error', (err) => {
    console.error('[redis]', err.message);
  });
  return client;
}

export const redis = globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

export async function ensureRedis() {
  if (redis.status === 'wait' || redis.status === 'end') {
    await redis.connect();
  }
  return redis;
}

/** Room presence + sample keys */
export const keys = {
  waiting: (code: string) => `room:${code}:waiting`,
  admitted: (code: string) => `room:${code}:admitted`,
  visible: (code: string) => `room:${code}:visible`,
  muted: (code: string) => `room:${code}:muted`,
  rotation: (code: string) => `room:${code}:rotation`,
  /** Exclusive presentation stage: idle | screen */
  stage: (code: string) => `room:${code}:stage`,
  /** '1' while the teacher's share draws student ink on the real desktop (Windows app). */
  desktopInk: (code: string) => `room:${code}:desktop-ink`,
  /** Hash identity → pinnedAt ms for active-speaker pins */
  pinnedSpeakers: (code: string) => `room:${code}:pinned-speakers`,
  /** Per-identity pin rate limit */
  pinRate: (code: string, identity: string) => `room:${code}:pin-rate:${identity}`,
  /** Short-lived mutex so only one client rotates the visible sample */
  rotateLock: (code: string) => `room:${code}:rotate-lock`,
  /** Hash participant id → JSON focus status (fullscreen / left / away / unsupported) */
  focus: (code: string) => `room:${code}:focus`,
  /** Set of participant ids with raised hands */
  hands: (code: string) => `room:${code}:hands`,
  /** Hash participant id -> ms when the hand went up (roster order). Kept beside `hands`. */
  handsAt: (code: string) => `room:${code}:hands-at`,
  /** Student drawing on the share: hash participant id -> ms of the request. */
  drawRequests: (code: string) => `room:${code}:draw-req`,
  /** JSON DrawHolder: the ONE student allowed to draw now (with its end time). */
  drawHolder: (code: string) => `room:${code}:draw-holder`,
  /** Hash stroke id -> JSON Stroke, and the drawing order (list of ids). */
  drawStrokes: (code: string) => `room:${code}:draw-strokes`,
  drawOrder: (code: string) => `room:${code}:draw-order`,
  /** JSON {s: sessionId, p: boolean}: is the teacher connected to the LiveKit room (webhook / probe) */
  teacherPresent: (code: string) => `room:${code}:teacher-present`,
};

export type StageMode = 'idle' | 'screen';

/**
 * Keys left behind by the removed whiteboard feature. Only deleted (on end /
 * reopen) so old deployments do not leak them; nothing reads or writes them.
 * Safe to drop after one release.
 */
export const legacyKeys = (code: string) => [
  `room:${code}:whiteboard`,
  `room:${code}:wb-write`,
  // Screen annotation layer (feature removed).
  `room:${code}:screen-annotate`,
];

