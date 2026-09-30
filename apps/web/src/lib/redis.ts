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
  /** Screen-share annotation strokes (JSON array), for late joiners */
  annotate: (code: string) => `room:${code}:screen-annotate`,
  /** Hash identity → pinnedAt ms for active-speaker pins */
  pinnedSpeakers: (code: string) => `room:${code}:pinned-speakers`,
  /** Per-identity pin rate limit */
  pinRate: (code: string, identity: string) => `room:${code}:pin-rate:${identity}`,
  /** Short-lived mutex so only one client rotates the visible sample */
  rotateLock: (code: string) => `room:${code}:rotate-lock`,
  /** Set of participant ids with raised hands */
  hands: (code: string) => `room:${code}:hands`,
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
];

