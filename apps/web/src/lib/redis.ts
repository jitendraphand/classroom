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
  whiteboard: (code: string) => `room:${code}:whiteboard`,
  /** Exclusive presentation stage: idle | screen | whiteboard */
  stage: (code: string) => `room:${code}:stage`,
  /** When set to "1", students may write on the shared whiteboard */
  wbWrite: (code: string) => `room:${code}:wb-write`,
  /** Hash identity → pinnedAt ms for active-speaker pins */
  pinnedSpeakers: (code: string) => `room:${code}:pinned-speakers`,
  /** Per-identity pin rate limit */
  pinRate: (code: string, identity: string) => `room:${code}:pin-rate:${identity}`,
};

export type StageMode = 'idle' | 'screen' | 'whiteboard';

export async function getStageMode(code: string): Promise<StageMode> {
  const redis = await ensureRedis();
  const v = await redis.get(keys.stage(code));
  if (v === 'screen' || v === 'whiteboard' || v === 'idle') return v;
  return 'idle';
}

export async function getWhiteboardWriteAllowed(code: string): Promise<boolean> {
  const redis = await ensureRedis();
  const v = await redis.get(keys.wbWrite(code));
  return v === '1';
}
