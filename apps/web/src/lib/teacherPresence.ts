import { roomServiceFor } from './livekit';
import { prisma } from './db';
import { acquireLock, releaseLock } from './leaderLock';
import { ensureRedis, keys } from './redis';
import { livekitRoomName, setParticipantPublishPermissions } from './livekit';
import { TEACHER_ABSENCE_GRACE_MS, createGraceTimers } from './graceTimer';
import { teacherPresentAmong, type PresenceParticipant, type RoomRef } from './teacherPresenceLogic';

/**
 * Live teacher presence (is the teacher connected to the LiveKit room right
 * now?) for the "students are force-muted while the teacher is away" rule.
 *
 * Source of truth is the SFU, never the DB roster:
 * - The LiveKit webhook (/api/livekit/webhook) records presence in Redis on
 *   every teacher join/leave and pushes the matching mic permission to every
 *   connected student.
 * - Without a fresh webhook record (webhooks not configured, Redis flushed) we
 *   ask LiveKit directly and cache the answer for a few seconds.
 *
 * The record is tagged with the room's sessionId, so a record from the previous
 * class on the same permanent code is ignored.
 */

type PresenceRecord = { s: string; p: boolean };

/** Webhook-written records last a class day; a probe result only a few seconds. */
const WEBHOOK_TTL_S = 12 * 60 * 60;
const PROBE_TTL_S = 5;
/**
 * During the teacher-absence grace period the record says "present" for a bit
 * longer than the grace delay. If the confirm timer is lost (process restart)
 * the record simply expires and the next check asks LiveKit: fails safe.
 */
const GRACE_TTL_S = Math.ceil(TEACHER_ABSENCE_GRACE_MS / 1000) + 5;

async function readRecord(room: RoomRef): Promise<boolean | null> {
  try {
    const redis = await ensureRedis();
    const raw = await redis.get(keys.teacherPresent(room.code));
    if (!raw) return null;
    const rec = JSON.parse(raw) as PresenceRecord;
    return rec?.s === room.sessionId ? !!rec.p : null;
  } catch {
    return null;
  }
}

export async function recordTeacherPresence(
  room: RoomRef,
  present: boolean,
  source: 'webhook' | 'probe' | 'grace' = 'webhook'
): Promise<void> {
  const redis = await ensureRedis();
  const rec: PresenceRecord = { s: room.sessionId, p: present };
  await redis.set(
    keys.teacherPresent(room.code),
    JSON.stringify(rec),
    'EX',
    source === 'webhook' ? WEBHOOK_TTL_S : source === 'grace' ? GRACE_TTL_S : PROBE_TTL_S
  );
}

/** Fast path on the worker that got the webhook. Redis is the cross-worker source of truth. */
const absenceTimers = createGraceTimers({ delayMs: TEACHER_ABSENCE_GRACE_MS });
const timerKey = (room: RoomRef) => `${room.code}:${room.sessionId}`;
const dueMember = (room: RoomRef) => `${room.code}|${room.sessionId}`;

export function deferTeacherAbsence(room: RoomRef, confirm: () => Promise<void>) {
  const due = Date.now() + TEACHER_ABSENCE_GRACE_MS;
  void (async () => {
    try {
      const redis = await ensureRedis();
      await redis.zadd(keys.teacherAbsenceDue(), due, dueMember(room));
    } catch {
      /* in-process timer still runs on this worker */
    }
  })();
  absenceTimers.schedule(timerKey(room), confirm);
}

export function cancelTeacherAbsence(room: RoomRef) {
  absenceTimers.cancel(timerKey(room));
  void (async () => {
    try {
      const redis = await ensureRedis();
      await redis.zrem(keys.teacherAbsenceDue(), dueMember(room));
    } catch {
      /* ignore */
    }
  })();
}

/**
 * Any worker: confirm absences whose grace elapsed (covers the webhook worker
 * dying mid-timer). Confirm still re-lists LiveKit so a returned teacher is
 * not locked.
 */
export async function sweepTeacherAbsences(now = Date.now()): Promise<number> {
  let redis: Awaited<ReturnType<typeof ensureRedis>>;
  try {
    redis = await ensureRedis();
  } catch {
    return 0;
  }
  const due = await redis.zrangebyscore(keys.teacherAbsenceDue(), 0, now);
  let n = 0;
  for (const member of due) {
    const bar = member.indexOf('|');
    if (bar <= 0) {
      await redis.zrem(keys.teacherAbsenceDue(), member);
      continue;
    }
    const room: RoomRef = { code: member.slice(0, bar), sessionId: member.slice(bar + 1) };
    const lockKey = `lock:absence:${member}`;
    const token = await acquireLock(lockKey, 30);
    if (!token) continue;
    try {
      await redis.zrem(keys.teacherAbsenceDue(), member);
      let stillAbsent: boolean;
      try {
        stillAbsent = !teacherPresentAmong(await listRoomParticipants(room));
      } catch {
        stillAbsent = true;
      }
      if (!stillAbsent) continue;
      await recordTeacherPresence(room, false, 'webhook');
      await applyStudentMicLock(room, false);
      n++;
    } finally {
      await releaseLock(lockKey, token);
    }
  }
  return n;
}

export function startAbsenceSweeper() {
  const tick = () => {
    void sweepTeacherAbsences().catch((e) => console.warn('[absence] sweep', e instanceof Error ? e.message : e));
  };
  const iv = setInterval(tick, 1000);
  iv.unref?.();
}

export async function recordTeacherGrace(room: RoomRef) {
  await recordTeacherPresence(room, true, 'grace');
}

/** Participants the SFU currently has in this class's LiveKit room ([] if the room does not exist yet). */
export async function listRoomParticipants(room: RoomRef): Promise<PresenceParticipant[]> {
  try {
    const rn = livekitRoomName(room.code, room.sessionId);
    const list = await (await roomServiceFor(rn)).listParticipants(rn);
    return list.map((p) => ({
      identity: p.identity,
      sid: p.sid,
      metadata: p.metadata,
      state: typeof p.state === 'number' ? p.state : undefined,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The room is only created when the first participant connects.
    if (/not.?found|does not exist/i.test(msg)) return [];
    throw e;
  }
}

/** Ask the SFU and cache briefly. Fails OPEN (true) if LiveKit cannot be reached, logged. */
async function probe(room: RoomRef): Promise<boolean> {
  try {
    const present = teacherPresentAmong(await listRoomParticipants(room));
    await recordTeacherPresence(room, present, 'probe').catch(() => undefined);
    return present;
  } catch (e) {
    console.warn('teacher presence probe failed; not locking student mics', room.code, e);
    return true;
  }
}

const inflightProbes = new Map<string, Promise<boolean>>();

/** Is the teacher connected to this class's LiveKit room right now? */
export async function isTeacherPresent(code: string, known?: RoomRef | null): Promise<boolean> {
  const room =
    known ??
    (await prisma.room.findUnique({ where: { code }, select: { code: true, sessionId: true } }));
  if (!room) return false;
  const cached = await readRecord(room);
  if (cached !== null) return cached;
  // Single flight per room and process: a burst of joins (run 4: hundreds of
  // students at once) made one LiveKit listParticipants call EACH.
  const k = timerKey(room);
  let p = inflightProbes.get(k);
  if (!p) {
    p = probe(room).finally(() => inflightProbes.delete(k));
    inflightProbes.set(k, p);
  }
  return p;
}

/**
 * Push the correct mic permission to every student currently connected to the
 * SFU: locked while the teacher is away; while present, each student's own
 * teacher-mute state decides (a teacher mute always wins). Restoring the
 * permission never turns a student's microphone on; they unmute themselves.
 */
export async function applyStudentMicLock(
  room: RoomRef,
  teacherPresent: boolean,
  onlyIdentities?: string[]
): Promise<void> {
  let identities: string[];
  try {
    identities = (await listRoomParticipants(room))
      .filter((p) => p.identity.startsWith('student_'))
      .map((p) => p.identity);
  } catch (e) {
    console.warn('applyStudentMicLock: listParticipants failed', room.code, e);
    return;
  }
  if (onlyIdentities) identities = identities.filter((i) => onlyIdentities.includes(i));
  if (!identities.length) return;

  const dbRoom = await prisma.room.findUnique({ where: { code: room.code }, select: { id: true } });
  if (!dbRoom) return;
  const students = await prisma.participant.findMany({
    where: { roomId: dbRoom.id, role: 'STUDENT', livekitIdentity: { in: identities } },
    select: { id: true, livekitIdentity: true, mutedByTeacher: true },
  });
  const redis = await ensureRedis();
  const [mutedIds, visible] = await Promise.all([
    redis.smembers(keys.muted(room.code)),
    redis.smembers(keys.visible(room.code)),
  ]);
  const muted = new Set(mutedIds);
  const inSample = new Set(visible);

  await Promise.allSettled(
    students.map((s) =>
      setParticipantPublishPermissions(
        room.code,
        s.livekitIdentity,
        {
          allowCamera: inSample.has(s.livekitIdentity),
          allowMic: !(s.mutedByTeacher || muted.has(s.id)),
        },
        { teacherPresent }
      )
    )
  );
}
