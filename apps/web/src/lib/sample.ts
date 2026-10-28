import type Redis from 'ioredis';
import { ensureRedis, keys } from './redis';
import { prisma } from './db';
import { pushStudentPermissions } from './livekit';
import { LOCK_RELEASE_LUA, newLockToken } from './leaderLock';
import { nudgeRoomState } from './roomNudge';
import { allocateSample, freshSpeakerPins, type PinnedStudent } from './classSlots';

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

/**
 * Cap on remembered speaker pins. Pins expire SPEAKER_PIN_TTL_SECONDS after the
 * student last spoke (and on mute); the ceiling stops a burst of chatty
 * students from holding every slot meanwhile.
 */
const MAX_STICKY_PINS = 12;

/** Guard so a poll storm cannot trigger dozens of concurrent rotations. */
const ROTATE_LOCK_MS = 3000;

export function clampMaxVisible(n: number | undefined | null): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : DEFAULT_MAX;
  return Math.min(HARD_MAX_VISIBLE_STUDENT_VIDEOS, Math.max(1, Math.floor(v)));
}

/**
 * Push effective publish permissions to LiveKit for every identity whose
 * visible-sample membership changed: camera follows membership, mic follows
 * the teacher-mute flags (both are sent together: writing canPublishSources
 * replaces the whole list). One participant query, one Redis call and one
 * bounded LiveKit batch per rotation (lib/livekit pushStudentPermissions).
 *
 * Returns the participant ids of the students whose membership changed, so
 * only they (and the teacher) are told to refetch.
 *
 * Failures are swallowed: the next token mint (and every poll of `/state`)
 * carries the same truth; this makes a connected client drop the track at once.
 */
export async function syncSampleMembership(roomCode: string, before: string[], after: string[]): Promise<string[]> {
  const prev = new Set(before);
  const next = new Set(after);
  const changed = [...before.filter((id) => !next.has(id)), ...after.filter((id) => !prev.has(id))];
  if (!changed.length) return [];
  try {
    const parts = await prisma.participant.findMany({
      where: { livekitIdentity: { in: changed }, role: 'STUDENT' },
      select: { id: true, livekitIdentity: true, mutedByTeacher: true },
    });
    if (!parts.length) return [];
    const redis = await ensureRedis();
    const mutedFlags = await redis.smismember(keys.muted(roomCode), ...parts.map((p) => p.id));
    await pushStudentPermissions(
      roomCode,
      parts.map((p, i) => ({
        identity: p.livekitIdentity,
        allowCamera: next.has(p.livekitIdentity),
        allowMic: !p.mutedByTeacher && mutedFlags[i] !== 1,
      }))
    );
    return parts.map((p) => p.id);
  } catch (e) {
    console.warn('sample sync camera permissions', roomCode, e instanceof Error ? e.message : e);
    return [];
  }
}

/** One identity (kept for callers outside rotation). */
export async function syncCameraPermissionFor(roomCode: string, identity: string, inSample: boolean): Promise<void> {
  await syncSampleMembership(roomCode, inSample ? [] : [identity], inSample ? [identity] : []);
}

/**
 * LiveKit permission updates are slow when the SFU is busy, and a hung call
 * must not stall /state. Hands, mute, and admit are read on that poll.
 * Syncs for one room stay ordered so an older sample cannot overwrite a newer one.
 */
const livekitSyncTail = new Map<string, Promise<void>>();

function enqueueSampleSync(roomCode: string, before: string[], after: string[]) {
  const prev = livekitSyncTail.get(roomCode) ?? Promise.resolve();
  const job = prev
    .catch(() => undefined)
    .then(() => syncSampleMembership(roomCode, [...before], [...after]))
    .catch((e) => {
      console.warn('sample sync', roomCode, e);
      return [] as string[];
    })
    // Tell the students who entered or left the sample (and the teacher), after
    // the SFU permissions are in place. Every other student's view is unchanged:
    // a class-wide nudge here made 2,000 students refetch /state every rotation.
    .then((ids) => {
      if (ids.length) nudgeRoomState(roomCode, { participantIds: ids });
      else if (sampleChanged(before, after)) nudgeRoomState(roomCode, 'teacher');
    });
  livekitSyncTail.set(roomCode, job);
  // Drop the tail once it is the last job, so ended rooms do not stay in the map.
  void job.then(() => {
    if (livekitSyncTail.get(roomCode) === job) livekitSyncTail.delete(roomCode);
  });
}

function sampleChanged(a: string[], b: string[]) {
  if (a.length !== b.length) return true;
  const set = new Set(a);
  return b.some((id) => !set.has(id));
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
 * Speaker pins: identity -> last time they spoke. An unmuted speaker stays in
 * the visible pool until muted, leaving, or SPEAKER_PIN_TTL_MS of silence.
 */
async function getPinnedSpeakers(roomCode: string): Promise<Set<string>> {
  const redis = await ensureRedis();
  const raw = await redis.hgetall(keys.pinnedSpeakers(roomCode));
  return new Set(Object.keys(raw));
}

/** Speaker pins expire this long after the student last spoke (pinSpeaker refreshes it). */
const SPEAKER_PIN_TTL_MS = Math.max(5, Number(process.env.SPEAKER_PIN_TTL_SECONDS || 18)) * 1000;


export async function unpinSpeaker(roomCode: string, identity: string) {
  const redis = await ensureRedis();
  await redis.hdel(keys.pinnedSpeakers(roomCode), identity);
}

export async function clearPinnedSpeakers(roomCode: string) {
  const redis = await ensureRedis();
  await redis.del(keys.pinnedSpeakers(roomCode));
}

/**
 * Trim the sticky-speaker hash to the MAX_STICKY_PINS most recent entries.
 * The hash stores `identity -> pinnedAt ms`, so recency is recoverable.
 */
async function pruneStickyPins(redis: Redis, roomCode: string, keep: Set<string>) {
  const raw = await redis.hgetall(keys.pinnedSpeakers(roomCode));
  const entries = Object.entries(raw);
  if (entries.length <= MAX_STICKY_PINS) return;
  entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const drop = entries
    .slice(MAX_STICKY_PINS)
    .map(([id]) => id)
    .filter((id) => !keep.has(id));
  if (drop.length) {
    await redis.hdel(keys.pinnedSpeakers(roomCode), ...drop);
    for (const id of drop) keep.delete(id);
  }
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
    select: { livekitIdentity: true, pinnedAt: true },
  });
  const teacherPins: PinnedStudent[] = admitted
    .filter((p) => p.pinnedAt)
    .map((p) => ({ identity: p.livekitIdentity, pinnedAt: p.pinnedAt!.getTime() }));

  const identities = admitted.map((p) => p.livekitIdentity);
  const identitySet = new Set(identities);
  const pinned = await getPinnedSpeakers(roomCode);

  // Drop pins for students who left
  const stalePins = Array.from(pinned).filter((id) => !identitySet.has(id));
  if (stalePins.length) {
    await redis.hdel(keys.pinnedSpeakers(roomCode), ...stalePins);
    for (const id of stalePins) pinned.delete(id);
  }

  // Keep the most recently pinned MAX_STICKY_PINS so stale pins can never
  // accumulate across a long class and monopolise every slot.
  await pruneStickyPins(redis, roomCode, pinned);

  // Teacher-pinned students first (oldest pin first), then sticky speakers
  // (random subset if more than fit), then random rotation among the rest.
  const pinTimes = await redis.hgetall(keys.pinnedSpeakers(roomCode));
  const expired = Object.entries(pinTimes)
    .filter(([, at]) => Date.now() - Number(at || 0) > SPEAKER_PIN_TTL_MS)
    .map(([id]) => id);
  if (expired.length) {
    await redis.hdel(keys.pinnedSpeakers(roomCode), ...expired);
    for (const id of expired) delete pinTimes[id];
  }
  const speakerPins = freshSpeakerPins(
    Object.fromEntries(Object.entries(pinTimes).filter(([id]) => pinned.has(id))),
    { now: Date.now(), ttlMs: SPEAKER_PIN_TTL_MS, max: n, admitted: identities.length, teacherPinned: teacherPins.length }
  );
  const sample = allocateSample({ identities, teacherPins, speakerPins, max: n, shuffle });

  const previous = await redis.smembers(keys.visible(roomCode));

  const pipe = redis.multi();
  pipe.del(keys.visible(roomCode));
  if (sample.length) pipe.sadd(keys.visible(roomCode), ...sample);
  pipe.set(keys.rotation(roomCode), String(Date.now()), 'EX', ROTATION_SECONDS * 3);
  await pipe.exec();

  // Permission updates run after the response. The Redis sample is already the
  // source of truth for the next /state poll.
  enqueueSampleSync(roomCode, previous, sample);

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
  if (rotatedAt && age <= ROTATION_SECONDS * 1000) {
    const sample = await getVisibleSample(roomCode);
    // Cap if somehow over hard max
    if (sample.visible.length > HARD_MAX_VISIBLE_STUDENT_VIDEOS) {
      return rotateVisibleSample(roomCode);
    }
    return sample;
  }

  // Teacher's student-video panel hidden: sampled students do not send video
  // (lib/camOnDemand), so rotating would only churn SFU permissions. Keep the
  // current sample until the panel is shown again (pins still apply at once).
  if (rotatedAt && (await redis.get(keys.videoPanel(roomCode))) === '0') {
    return getVisibleSample(roomCode);
  }

  // Stale (or missing) rotation marker. Every client polls this endpoint, so
  // without a lock a rotation boundary produces a stampede of concurrent
  // rotations — each a full participant read plus a clobbering write. Exactly
  // one caller rotates; the rest report the existing sample (possibly empty)
  // and pick the new one up on their next poll.
  const token = newLockToken();
  const lock = await redis.set(keys.rotateLock(roomCode), token, 'PX', ROTATE_LOCK_MS, 'NX');
  if (!lock) return getVisibleSample(roomCode);
  try {
    return await rotateVisibleSample(roomCode);
  } finally {
    // Compare-and-delete: a rotation slower than the lock must not drop the
    // next rotator's lock.
    await redis.eval(LOCK_RELEASE_LUA, 1, keys.rotateLock(roomCode), token).catch(() => undefined);
  }
}

/**
 * Force a speaking (unmuted) student into the visible sample so the teacher sees them.
 * Held while they keep speaking (expires SPEAKER_PIN_TTL_MS after the last
 * pin, dropped on mute) — rate-limited per identity; no-op if already visible.
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
  const teacherPinned = new Set(
    (
      await prisma.participant.findMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED', pinnedAt: { not: null } },
        select: { livekitIdentity: true },
      })
    ).map((p) => p.livekitIdentity)
  );
  let next = [...visible];

  if (next.length >= max) {
    // Never eject teacher-pinned students; avoid ejecting other sticky speakers.
    const notTeacherPinned = next.filter((id) => id !== identity && !teacherPinned.has(id));
    if (!notTeacherPinned.length) {
      // Every slot is pinned by the teacher: the speaker waits (the teacher
      // still hears them; their video joins when a pin is released).
      await redis.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
      return { ok: true as const, alreadyVisible: false, visible: next, slotsPinned: true };
    }
    const ejectable = notTeacherPinned.filter((id) => !pinned.has(id));
    const pool = ejectable.length ? ejectable : notTeacherPinned;
    const victim = pool[Math.floor(Math.random() * pool.length)];
    next = next.filter((id) => id !== victim);
  }

  if (!next.includes(identity)) next.push(identity);
  next = next.slice(0, max);

  const previous = await redis.smembers(keys.visible(roomCode));

  const pipe = redis.multi();
  pipe.del(keys.visible(roomCode));
  if (next.length) pipe.sadd(keys.visible(roomCode), ...next);
  pipe.hset(keys.pinnedSpeakers(roomCode), identity, String(Date.now()));
  await pipe.exec();

  // The pinned student may now publish camera — enforce that on the SFU, and
  // revoke it from whoever was pushed out of the sample. Do not block the pin
  // response (or the teacher's next state poll) on the SFU round-trip.
  enqueueSampleSync(roomCode, previous, next);

  return { ok: true as const, alreadyVisible: false, visible: next, pinned: identity };
}

/**
 * Drop a sticky speaker pin.
 *
 * Called when the teacher mutes a student, and when the teacher client sees that
 * student mute their own microphone — without this a student who speaks once and
 * then mutes holds a visible slot for the rest of the class.
 */
export async function unpinSpeakerByParticipant(roomCode: string, identity: string) {
  const redis = await ensureRedis();
  const wasPinned = await redis.hexists(keys.pinnedSpeakers(roomCode), identity);
  if (!wasPinned) return { ok: true as const, wasPinned: false };
  await redis.hdel(keys.pinnedSpeakers(roomCode), identity);
  return { ok: true as const, wasPinned: true };
}

/**
 * Teacher pins / unpins a student's video. Pinned students keep a visible slot
 * (bypassing rotation) for the rest of this class session; pins count toward
 * the room's video cap, so pinning beyond it is refused.
 */
export async function setStudentPinned(roomCode: string, participantId: string, pinnedOn: boolean) {
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room || room.status === 'ENDED') return { ok: false as const, reason: 'room_ended' as const };
  const participant = await prisma.participant.findFirst({
    where: { id: participantId, roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
    select: { id: true, pinnedAt: true },
  });
  if (!participant) return { ok: false as const, reason: 'not_student' as const };
  const max = clampMaxVisible(room.maxVisibleVideos ?? DEFAULT_MAX);
  if (pinnedOn) {
    if (participant.pinnedAt) return { ok: true as const, pinned: true, max };
    const count = await prisma.participant.count({
      where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED', pinnedAt: { not: null } },
    });
    if (count >= max) return { ok: false as const, reason: 'full' as const, max };
    await prisma.participant.update({ where: { id: participant.id }, data: { pinnedAt: new Date() } });
  } else {
    if (!participant.pinnedAt) return { ok: true as const, pinned: false, max };
    await prisma.participant.update({ where: { id: participant.id }, data: { pinnedAt: null } });
  }
  // Re-sample now so a new pin gets camera permission immediately (and an
  // unpinned slot goes back into rotation).
  await rotateVisibleSample(roomCode);
  return { ok: true as const, pinned: pinnedOn, max };
}

export function sampleConfig() {
  return {
    maxVisible: DEFAULT_MAX,
    hardMaxVisible: HARD_MAX_VISIBLE_STUDENT_VIDEOS,
    rotationSeconds: ROTATION_SECONDS,
    speakerPinTtlSeconds: SPEAKER_PIN_TTL_MS / 1000,
  };
}
