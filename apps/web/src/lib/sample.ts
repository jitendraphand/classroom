import { ensureRedis, keys } from './redis';
import { prisma } from './db';

/** Hard ceiling: server never selects/publishes more than this many student videos. */
export const HARD_MAX_VISIBLE_STUDENT_VIDEOS = 6;

const DEFAULT_MAX = Math.min(
  Math.max(1, Number(process.env.MAX_VISIBLE_STUDENT_VIDEOS || HARD_MAX_VISIBLE_STUDENT_VIDEOS)),
  HARD_MAX_VISIBLE_STUDENT_VIDEOS
);

/** Auto-rotate mosaic pool among non-pinned students (default 8s). */
const ROTATION_SECONDS = Number(process.env.SAMPLE_ROTATION_SECONDS || 8);

/** Do not re-pin the same identity more often than this. */
const PIN_RATE_LIMIT_MS = 2000;

export function clampMaxVisible(n: number | undefined | null): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : DEFAULT_MAX;
  return Math.min(HARD_MAX_VISIBLE_STUDENT_VIDEOS, Math.max(1, Math.floor(v)));
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Sticky speaker pins — no TTL expiry.
 * Unmuted speakers stay in the visible pool until muted (or leave).
 */
async function getPinnedSpeakers(roomCode: string): Promise<Set<string>> {
  const redis = await ensureRedis();
  const raw = await redis.hgetall(keys.pinnedSpeakers(roomCode));
  return new Set(Object.keys(raw));
}

export async function unpinSpeaker(roomCode: string, identity: string) {
  const redis = await ensureRedis();
  await redis.hdel(keys.pinnedSpeakers(roomCode), identity);
}

export async function unpinSpeakers(roomCode: string, identities: string[]) {
  if (!identities.length) return;
  const redis = await ensureRedis();
  await redis.hdel(keys.pinnedSpeakers(roomCode), ...identities);
}

export async function clearPinnedSpeakers(roomCode: string) {
  const redis = await ensureRedis();
  await redis.del(keys.pinnedSpeakers(roomCode));
}

/**
 * Rotate which admitted students may publish camera video to LiveKit.
 * Only identities in the visible sample should publish video tracks.
 * Audio can still be published by all unmuted students.
 * Sticky unmuted-speaker pins are never rotated out.
 */
export async function rotateVisibleSample(roomCode: string, maxVisible?: number) {
  const redis = await ensureRedis();
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room || room.status === 'ENDED') {
    return { visible: [] as string[], max: 0 };
  }

  const n = clampMaxVisible(maxVisible ?? room.maxVisibleVideos ?? DEFAULT_MAX);

  const admitted = await prisma.participant.findMany({
    where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
    select: { livekitIdentity: true },
  });

  const identities = admitted.map((p) => p.livekitIdentity);
  const identitySet = new Set(identities);
  const pinned = await getPinnedSpeakers(roomCode);

  // Drop pins for students who left
  const stalePins = Array.from(pinned).filter((id) => !identitySet.has(id));
  if (stalePins.length) {
    await redis.hdel(keys.pinnedSpeakers(roomCode), ...stalePins);
    for (const id of stalePins) pinned.delete(id);
  }

  // Prefer keeping sticky speakers, then fill randomly among the rest.
  const pinnedInRoom = identities.filter((id) => pinned.has(id));
  const rest = identities.filter((id) => !pinned.has(id));
  // If more pins than slots, keep a random subset of pins (still prefer speakers).
  const keepPinned = shuffle(pinnedInRoom).slice(0, Math.min(n, pinnedInRoom.length));
  const fill = shuffle(rest).slice(0, Math.max(0, n - keepPinned.length));
  const sample = [...keepPinned, ...fill].slice(0, n);

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
  // Never report more than hard max even if Redis was polluted
  return { visible: members.slice(0, HARD_MAX_VISIBLE_STUDENT_VIDEOS), rotatedAt };
}

export async function ensureSampleFresh(roomCode: string) {
  const redis = await ensureRedis();
  const rotatedAt = Number((await redis.get(keys.rotation(roomCode))) || 0);
  const age = Date.now() - rotatedAt;
  if (!rotatedAt || age > ROTATION_SECONDS * 1000) {
    return rotateVisibleSample(roomCode);
  }
  const sample = await getVisibleSample(roomCode);
  // Cap if somehow over hard max
  if (sample.visible.length > HARD_MAX_VISIBLE_STUDENT_VIDEOS) {
    return rotateVisibleSample(roomCode);
  }
  return sample;
}

/**
 * Force a speaking (unmuted) student into the visible sample so the teacher sees them.
 * Sticky until muted — rate-limited per identity; no-op if already visible.
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
    select: { livekitIdentity: true, mutedByTeacher: true, id: true },
  });
  if (!participant) {
    return { ok: false as const, reason: 'not_student' };
  }

  // Teacher-muted students should not stick in the speak pool
  const mutedIds = await redis.smembers(keys.muted(roomCode));
  if (participant.mutedByTeacher || mutedIds.includes(participant.id)) {
    await redis.hdel(keys.pinnedSpeakers(roomCode), identity);
    return { ok: false as const, reason: 'muted' };
  }

  const rateKey = keys.pinRate(roomCode, identity);
  const acquired = await redis.set(rateKey, '1', 'PX', PIN_RATE_LIMIT_MS, 'NX');
  if (!acquired) {
    // Still refresh sticky pin timestamp while speaking
    await redis.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
    return { ok: true as const, alreadyVisible: true, rateLimited: true };
  }

  const max = clampMaxVisible(room.maxVisibleVideos ?? DEFAULT_MAX);
  const visible = await redis.smembers(keys.visible(roomCode));

  if (visible.includes(identity)) {
    await redis.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
    return { ok: true as const, alreadyVisible: true, visible };
  }

  const pinned = await getPinnedSpeakers(roomCode);
  let next = [...visible];

  if (next.length >= max) {
    // Never eject other sticky speakers if avoidable
    const ejectable = next.filter((id) => id !== identity && !pinned.has(id));
    const pool = ejectable.length ? ejectable : next.filter((id) => id !== identity);
    if (pool.length) {
      const victim = pool[Math.floor(Math.random() * pool.length)];
      next = next.filter((id) => id !== victim);
    } else if (next.length >= max) {
      const victim = next[Math.floor(Math.random() * next.length)];
      next = next.filter((id) => id !== victim);
    }
  }

  if (!next.includes(identity)) next.push(identity);
  next = next.slice(0, max);

  const pipe = redis.multi();
  pipe.del(keys.visible(roomCode));
  if (next.length) pipe.sadd(keys.visible(roomCode), ...next);
  pipe.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
  await pipe.exec();

  return { ok: true as const, alreadyVisible: false, visible: next, pinned: identity };
}

export function sampleConfig() {
  return {
    maxVisible: DEFAULT_MAX,
    hardMaxVisible: HARD_MAX_VISIBLE_STUDENT_VIDEOS,
    rotationSeconds: ROTATION_SECONDS,
    /** Pins last until mute (no TTL). Kept for health/docs compatibility. */
    speakerPinUntilMute: true,
  };
}
