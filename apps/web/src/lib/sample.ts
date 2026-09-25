import { ensureRedis, keys } from './redis';
import { prisma } from './db';

const DEFAULT_MAX = Number(process.env.MAX_VISIBLE_STUDENT_VIDEOS || 10);
/** Auto-rotate visible student cameras (default 8s; override with SAMPLE_ROTATION_SECONDS). */
const ROTATION_SECONDS = Number(process.env.SAMPLE_ROTATION_SECONDS || 8);
/** Keep speaker-pinned identities protected from random ejection for this long. */
const SPEAKER_PIN_TTL_MS = Number(process.env.SPEAKER_PIN_TTL_SECONDS || 18) * 1000;
/** Do not re-pin the same identity more often than this. */
const PIN_RATE_LIMIT_MS = 2000;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getPinnedSpeakers(roomCode: string): Promise<Set<string>> {
  const redis = await ensureRedis();
  const raw = await redis.hgetall(keys.pinnedSpeakers(roomCode));
  const now = Date.now();
  const alive = new Set<string>();
  const expired: string[] = [];
  for (const [identity, ts] of Object.entries(raw)) {
    const pinnedAt = Number(ts);
    if (!pinnedAt || now - pinnedAt > SPEAKER_PIN_TTL_MS) {
      expired.push(identity);
    } else {
      alive.add(identity);
    }
  }
  if (expired.length) {
    await redis.hdel(keys.pinnedSpeakers(roomCode), ...expired);
  }
  return alive;
}

/**
 * Rotate which admitted students may publish camera video to LiveKit.
 * Only identities in the visible sample should publish video tracks.
 * Audio can still be published by all unmuted students.
 * Recently speaker-pinned identities are preferred to stay in the sample.
 */
export async function rotateVisibleSample(roomCode: string, maxVisible?: number) {
  const redis = await ensureRedis();
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room || room.status === 'ENDED') {
    return { visible: [] as string[], max: 0 };
  }

  const n = maxVisible ?? room.maxVisibleVideos ?? DEFAULT_MAX;

  const admitted = await prisma.participant.findMany({
    where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
    select: { livekitIdentity: true },
  });

  const identities = admitted.map((p) => p.livekitIdentity);
  const pinned = await getPinnedSpeakers(roomCode);

  // Prefer keeping recently pinned speakers, then fill randomly.
  const pinnedInRoom = identities.filter((id) => pinned.has(id));
  const rest = identities.filter((id) => !pinned.has(id));
  const keepPinned = shuffle(pinnedInRoom).slice(0, Math.min(n, pinnedInRoom.length));
  const fill = shuffle(rest).slice(0, Math.max(0, n - keepPinned.length));
  const sample = [...keepPinned, ...fill];

  const pipe = redis.multi();
  pipe.del(keys.visible(roomCode));
  if (sample.length) pipe.sadd(keys.visible(roomCode), ...sample);
  pipe.set(keys.rotation(roomCode), String(Date.now()), 'EX', ROTATION_SECONDS * 3);
  await pipe.exec();

  return { visible: sample, max: n, rotatedAt: Date.now(), nextIn: ROTATION_SECONDS };
}

export async function getVisibleSample(roomCode: string) {
  const redis = await ensureRedis();
  const members = await redis.smembers(keys.visible(roomCode));
  const rotatedAt = Number((await redis.get(keys.rotation(roomCode))) || 0);
  return { visible: members, rotatedAt };
}

export async function ensureSampleFresh(roomCode: string) {
  const redis = await ensureRedis();
  const rotatedAt = Number((await redis.get(keys.rotation(roomCode))) || 0);
  const age = Date.now() - rotatedAt;
  if (!rotatedAt || age > ROTATION_SECONDS * 1000) {
    return rotateVisibleSample(roomCode);
  }
  return getVisibleSample(roomCode);
}

/**
 * Force a speaking student into the visible sample so the teacher sees their video.
 * Rate-limited per identity; no-op if already visible. Pins expire after ~18s.
 */
export async function pinSpeaker(roomCode: string, identity: string) {
  const redis = await ensureRedis();
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room || room.status === 'ENDED') {
    return { ok: false as const, reason: 'room_ended' };
  }

  const participant = await prisma.participant.findFirst({
    where: {
      roomId: room.id,
      livekitIdentity: identity,
      role: 'STUDENT',
      status: 'ADMITTED',
    },
    select: { livekitIdentity: true },
  });
  if (!participant) {
    return { ok: false as const, reason: 'not_student' };
  }

  const rateKey = keys.pinRate(roomCode, identity);
  const acquired = await redis.set(rateKey, '1', 'PX', PIN_RATE_LIMIT_MS, 'NX');
  if (!acquired) {
    return { ok: true as const, alreadyVisible: true, rateLimited: true };
  }

  const max = room.maxVisibleVideos ?? DEFAULT_MAX;
  const visible = await redis.smembers(keys.visible(roomCode));

  if (visible.includes(identity)) {
    await redis.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
    await redis.expire(keys.pinnedSpeakers(roomCode), Math.ceil((SPEAKER_PIN_TTL_MS / 1000) * 2));
    return { ok: true as const, alreadyVisible: true, visible };
  }

  const pinned = await getPinnedSpeakers(roomCode);
  let next = [...visible];

  if (next.length >= max) {
    const ejectable = next.filter((id) => id !== identity && !pinned.has(id));
    const pool = ejectable.length ? ejectable : next.filter((id) => id !== identity);
    if (pool.length) {
      const victim = pool[Math.floor(Math.random() * pool.length)];
      next = next.filter((id) => id !== victim);
    } else if (next.length >= max) {
      // All slots are pinned speakers — still make room for the new speaker.
      const victim = next[Math.floor(Math.random() * next.length)];
      next = next.filter((id) => id !== victim);
    }
  }

  if (!next.includes(identity)) next.push(identity);

  const pipe = redis.multi();
  pipe.del(keys.visible(roomCode));
  if (next.length) pipe.sadd(keys.visible(roomCode), ...next);
  pipe.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
  pipe.expire(keys.pinnedSpeakers(roomCode), Math.ceil((SPEAKER_PIN_TTL_MS / 1000) * 2));
  await pipe.exec();

  return { ok: true as const, alreadyVisible: false, visible: next, pinned: identity };
}

export function sampleConfig() {
  return {
    maxVisible: DEFAULT_MAX,
    rotationSeconds: ROTATION_SECONDS,
    speakerPinTtlMs: SPEAKER_PIN_TTL_MS,
  };
}
