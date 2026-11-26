import { ensureRedis, keys } from './redis';
import { prisma } from './db';
import { pushStudentPermissions } from './livekit';
import { LOCK_RELEASE_LUA, newLockToken } from './leaderLock';
import { nudgeRoomState } from './roomNudge';
import { type PinnedStudent } from './classSlots';
import { studentCamMap } from './studentCamera';
import { videoPageLayout, type VideoPageLayout } from './videoPages';

/** Hard ceiling: server never selects/publishes more than this many student videos. */
export const HARD_MAX_VISIBLE_STUDENT_VIDEOS = 6;

const DEFAULT_MAX = Math.min(
  Math.max(1, Number(process.env.MAX_VISIBLE_STUDENT_VIDEOS || HARD_MAX_VISIBLE_STUDENT_VIDEOS)),
  HARD_MAX_VISIBLE_STUDENT_VIDEOS
);

/**
 * How often the current page is recomputed (default 8 s): picks up students
 * who joined, left or turned their camera on/off. The page itself only
 * changes when the teacher presses Prev / Next (lib/videoPages); there is no
 * random rotation any more.
 */
const ROTATION_SECONDS = Number(process.env.SAMPLE_ROTATION_SECONDS || 8);

/** Page state lives as long as a class can (same as the student camera flags). */
const PAGE_TTL_S = 12 * 60 * 60;

/** Guard so a poll storm cannot trigger dozens of concurrent page recomputes. */
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

/** Page summary the teacher's panel shows (Prev / Next, "Page 2 of 9"). */
export type VideoPageInfo = Pick<VideoPageLayout, 'page' | 'pages' | 'pageSize' | 'total' | 'order'>;

export async function getVideoPageInfo(roomCode: string): Promise<VideoPageInfo | null> {
  const redis = await ensureRedis();
  try {
    const raw = await redis.get(keys.videoPageInfo(roomCode));
    return raw ? (JSON.parse(raw) as VideoPageInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Recompute which admitted students may publish camera video: the students
 * the teacher pinned, then the current page of camera-on students in roster
 * order (lib/videoPages). Deterministic, so recomputing without a change
 * keeps the same students and pushes no SFU permission changes. `page`
 * moves to another page (clamped to the pages that exist).
 */
export async function rotateVisibleSample(roomCode: string, maxVisible?: number, page?: number) {
  const redis = await ensureRedis();
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room || room.status === 'ENDED') {
    return { visible: [] as string[], max: 0 };
  }

  const n = clampMaxVisible(maxVisible ?? room.maxVisibleVideos ?? DEFAULT_MAX);

  const [admitted, cams, storedPage] = await Promise.all([
    prisma.participant.findMany({
      where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
      select: { livekitIdentity: true, pinnedAt: true, displayName: true },
    }),
    studentCamMap(roomCode),
    page === undefined ? redis.get(keys.videoPage(roomCode)) : Promise.resolve(null),
  ]);
  const teacherPins: PinnedStudent[] = admitted
    .filter((p) => p.pinnedAt)
    .map((p) => ({ identity: p.livekitIdentity, pinnedAt: p.pinnedAt!.getTime() }));

  const layout = videoPageLayout({
    candidates: admitted.map((p) => ({ identity: p.livekitIdentity, name: p.displayName, camOn: cams.get(p.livekitIdentity) === true })),
    teacherPins,
    max: n,
    page: page ?? Number(storedPage || 0),
  });
  const sample = layout.visible;
  const info: VideoPageInfo = { page: layout.page, pages: layout.pages, pageSize: layout.pageSize, total: layout.total, order: layout.order };

  const previous = await redis.smembers(keys.visible(roomCode));

  const pipe = redis.multi();
  pipe.del(keys.visible(roomCode));
  if (sample.length) pipe.sadd(keys.visible(roomCode), ...sample);
  pipe.set(keys.rotation(roomCode), String(Date.now()), 'EX', ROTATION_SECONDS * 3);
  pipe.set(keys.videoPage(roomCode), String(layout.page), 'EX', PAGE_TTL_S);
  pipe.set(keys.videoPageInfo(roomCode), JSON.stringify(info), 'EX', PAGE_TTL_S);
  await pipe.exec();

  // Permission updates run after the response. The Redis sample is already the
  // source of truth for the next /state poll.
  enqueueSampleSync(roomCode, previous, sample);

  return { visible: sample, max: n, rotatedAt: Date.now(), nextIn: ROTATION_SECONDS, ...info };
}

/** Teacher pressed Prev / Next (delta) or picked a page: move there now. */
export async function moveVideoPage(roomCode: string, target: { page?: number; delta?: number }) {
  const { stepPage } = await import('./videoPages');
  const current = await getVideoPageInfo(roomCode);
  const page =
    target.page !== undefined
      ? target.page
      : stepPage(current?.page ?? 0, current?.pages ?? 1, target.delta ?? 1);
  return rotateVisibleSample(roomCode, undefined, page);
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
    refreshSeconds: ROTATION_SECONDS,
  };
}
