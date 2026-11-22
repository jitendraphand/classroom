/**
 * Mic-limit housekeeping (Admin → Class size and microphones → "Student
 * microphones open at once"). Pure rules live in micSlots.ts; this applies
 * them: DB flag, Redis muted set, LiveKit permissions (awaited, with retry),
 * the students' clients and the teacher's roster.
 *
 * - releaseMicSlot: a student leaves, is removed, disconnects, or holds a slot
 *   without turning the mic on → free the slot, promote the next
 *   teacher-approved waiter.
 * - reconcileMicLimit: the admin changed the limit → rebuild every live
 *   room's book from who is actually unmuted.
 * - sweepIdleMicSlots: slots granted MIC_IDLE_MS ago whose student never
 *   turned the mic on.
 */
import { TrackSource } from 'livekit-server-sdk';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { readMicBook, updateMicBook } from './micBook';
import { idlePending, rebuildForLimit, studentSetMic, type MicBook } from './micSlots';
import { getSchoolSettings } from './schoolSettings';
import { livekitRoomName, pushStudentPermissions, roomServiceFor } from './livekit';
import { getVisibleSample, unpinSpeaker } from './sample';
import { nudgeRoomState, pushMuteState } from './roomNudge';
import { acquireLock, releaseLock } from './leaderLock';

export type MicRoom = { id: string; code: string; sessionId: string };

/** Mute and unmute students of one room (admitted students only get LiveKit pushes). */
export async function applyMicChanges(room: MicRoom, mute: string[], unmute: string[]): Promise<{ failed: string[] }> {
  const ids = [...new Set([...mute, ...unmute])];
  if (!ids.length) return { failed: [] };
  const rows = await prisma.participant.findMany({
    where: { roomId: room.id, id: { in: ids }, role: 'STUDENT' },
    select: { id: true, livekitIdentity: true, status: true },
  });
  const muteSet = new Set(mute);
  const unmuteSet = new Set(unmute.filter((id) => !muteSet.has(id)));
  const muted = rows.filter((r) => muteSet.has(r.id));
  const opened = rows.filter((r) => unmuteSet.has(r.id) && r.status === 'ADMITTED');
  if (muted.length) await prisma.participant.updateMany({ where: { id: { in: muted.map((r) => r.id) } }, data: { mutedByTeacher: true } });
  if (opened.length) await prisma.participant.updateMany({ where: { id: { in: opened.map((r) => r.id) } }, data: { mutedByTeacher: false } });
  const redis = await ensureRedis();
  const m = redis.multi();
  if (muted.length) m.sadd(keys.muted(room.code), ...muted.map((r) => r.id));
  if (opened.length) m.srem(keys.muted(room.code), ...opened.map((r) => r.id));
  await m.exec();
  const { visible } = await getVisibleSample(room.code);
  const inSample = new Set(visible);
  const live = [...muted.filter((r) => r.status === 'ADMITTED'), ...opened];
  const res = await pushStudentPermissions(
    room.code,
    live.map((r) => ({ identity: r.livekitIdentity, allowMic: unmuteSet.has(r.id), allowCamera: inSample.has(r.livekitIdentity) })),
    { room }
  );
  for (const r of muted) await unpinSpeaker(room.code, r.livekitIdentity).catch(() => undefined);
  pushMuteState(room.code, room.sessionId, muted.filter((r) => r.status === 'ADMITTED').map((r) => r.livekitIdentity), true);
  pushMuteState(room.code, room.sessionId, opened.map((r) => r.livekitIdentity), false);
  nudgeRoomState(room.code, { participantIds: live.map((r) => r.id) });
  nudgeRoomState(room.code, 'teacher');
  if (res.failed.length) console.error('[mic] LiveKit permission push failed for', res.failed.length, 'student(s) in', room.code);
  return res;
}

/**
 * Free this student's slot (or queue place) when a mic limit is set; the next
 * teacher-approved waiter who is still in the class gets it. `mute` also
 * teacher-mutes the student (idle slot, disconnect); a student who left is
 * muted anyway (students rejoin muted).
 */
export async function releaseMicSlot(room: MicRoom, participantId: string, opts: { mute?: boolean } = {}): Promise<{ released: boolean; promoted: string[] }> {
  const { maxOpenStudentMics: cap } = await getSchoolSettings();
  if (cap <= 0) return { released: false, promoted: [] };
  const book = await readMicBook(room.code);
  if (!book.open.includes(participantId) && !book.queue.some((w) => w.id === participantId)) return { released: false, promoted: [] };
  const promoted: string[] = [];
  const mute = opts.mute ? [participantId] : [];
  let releasing: string | null = participantId;
  // A promoted waiter who already left frees the slot again (bounded).
  for (let i = 0; releasing && i < 10; i++) {
    const id: string = releasing;
    releasing = null;
    const out = await updateMicBook(room.code, (b) => ({ next: studentSetMic(b, id, false, cap) }));
    const p = (out.next as MicBook & { promoted?: string | null }).promoted ?? null;
    if (!p) break;
    const row = await prisma.participant.findFirst({ where: { id: p, roomId: room.id }, select: { status: true } });
    if (row?.status === 'ADMITTED') promoted.push(p);
    else releasing = p;
  }
  await applyMicChanges(room, mute, promoted);
  return { released: true, promoted };
}

/** Same, by LiveKit identity (webhook disconnect). */
export async function releaseMicSlotByIdentity(code: string, identity: string, opts: { mute?: boolean } = {}) {
  const { maxOpenStudentMics: cap } = await getSchoolSettings();
  if (cap <= 0) return { released: false, promoted: [] as string[] };
  const room = await prisma.room.findUnique({ where: { code }, select: { id: true, code: true, sessionId: true, status: true } });
  if (!room || room.status === 'ENDED') return { released: false, promoted: [] as string[] };
  const p = await prisma.participant.findFirst({ where: { roomId: room.id, livekitIdentity: identity, role: 'STUDENT' }, select: { id: true } });
  if (!p) return { released: false, promoted: [] as string[] };
  return releaseMicSlot(room, p.id, opts);
}

/** Grace before a disconnected student's slot is freed (a quick reconnect keeps it). */
export const MIC_DISCONNECT_GRACE_MS = 10_000;

/** LiveKit participant_left for a student: after the grace, free the slot if they are still gone. */
export function scheduleDisconnectRelease(code: string, sessionId: string, identity: string) {
  const t = setTimeout(() => {
    void (async () => {
      try {
        const { maxOpenStudentMics: cap } = await getSchoolSettings();
        if (cap <= 0) return;
        const book = await readMicBook(code);
        if (!book.open.length && !book.queue.length) return;
        const rn = livekitRoomName(code, sessionId);
        const list = await (await roomServiceFor(rn)).listParticipants(rn).catch(() => []);
        if (list.some((p) => p.identity === identity)) return; // reconnected
        await releaseMicSlotByIdentity(code, identity, { mute: true });
      } catch (e) {
        console.warn('[mic] disconnect release', e instanceof Error ? e.message : e);
      }
    })();
  }, MIC_DISCONNECT_GRACE_MS);
  t.unref?.();
}

/** The admin changed the limit: rebuild every live room's book from who is unmuted now. */
export async function reconcileMicLimit(limit: number): Promise<{ rooms: number; muted: number; unmuted: number }> {
  const rooms = await prisma.room.findMany({ where: { status: { not: 'ENDED' } }, select: { id: true, code: true, sessionId: true } });
  let muted = 0;
  let unmuted = 0;
  for (const room of rooms) {
    const students = await prisma.participant.findMany({
      where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, mutedByTeacher: true },
    });
    const present = students.map((s) => s.id);
    const on = students.filter((s) => !s.mutedByTeacher).map((s) => s.id);
    const out = await updateMicBook(room.code, (b) => {
      const r = rebuildForLimit(b, on, present, limit);
      return { next: r.next, mute: r.mute, unmute: r.unmute };
    });
    await applyMicChanges(room, out.mute, out.unmute);
    nudgeRoomState(room.code, 'teacher');
    muted += out.mute.length;
    unmuted += out.unmute.length;
  }
  return { rooms: rooms.length, muted, unmuted };
}

/** Is this LiveKit participant sending an unmuted microphone? */
export function micIsOn(tracks: { source?: TrackSource | number; muted?: boolean }[] | undefined): boolean {
  return (tracks ?? []).some((t) => t.source === TrackSource.MICROPHONE && !t.muted);
}

/** Free slots granted MIC_IDLE_MS ago whose student never turned the mic on; confirm the others. */
export async function sweepIdleMicSlots(now = Date.now()): Promise<number> {
  let redis: Awaited<ReturnType<typeof ensureRedis>>;
  try {
    redis = await ensureRedis();
  } catch {
    return 0;
  }
  const codes = await redis.smembers(keys.micPendingRooms());
  let freed = 0;
  for (const code of codes) {
    const lockKey = `lock:mic-idle:${code}`;
    const token = await acquireLock(lockKey, 20);
    if (!token) continue;
    try {
      const { maxOpenStudentMics: cap } = await getSchoolSettings();
      const book = await readMicBook(code);
      if (cap <= 0 || !Object.keys(book.pending ?? {}).length) {
        await redis.srem(keys.micPendingRooms(), code);
        continue;
      }
      const due = idlePending(book, now);
      if (!due.length) continue;
      const room = await prisma.room.findUnique({ where: { code }, select: { id: true, code: true, sessionId: true, status: true } });
      if (!room || room.status === 'ENDED') {
        await redis.srem(keys.micPendingRooms(), code);
        continue;
      }
      const rows = await prisma.participant.findMany({ where: { id: { in: due }, roomId: room.id }, select: { id: true, livekitIdentity: true } });
      const rn = livekitRoomName(room.code, room.sessionId);
      let list: { identity: string; tracks?: { source?: TrackSource; muted?: boolean }[] }[];
      try {
        list = await (await roomServiceFor(rn)).listParticipants(rn);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/not.?found|does not exist/i.test(msg)) {
          console.warn('[mic] idle sweep list', code, msg);
          continue; // try again next tick rather than muting on an SFU hiccup
        }
        list = [];
      }
      const byIdentity = new Map(list.map((p) => [p.identity, p]));
      const confirmed: string[] = [];
      for (const r of rows) {
        if (micIsOn(byIdentity.get(r.livekitIdentity)?.tracks)) confirmed.push(r.id);
      }
      if (confirmed.length) {
        await updateMicBook(code, (b) => {
          const pending = { ...(b.pending ?? {}) };
          for (const id of confirmed) delete pending[id];
          return { next: { ...b, pending } };
        });
      }
      const idle = due.filter((id) => !confirmed.includes(id));
      for (const id of idle) {
        const r = await releaseMicSlot(room, id, { mute: true });
        if (r.released) freed++;
      }
      const after = await readMicBook(code);
      if (!Object.keys(after.pending ?? {}).length) await redis.srem(keys.micPendingRooms(), code);
    } catch (e) {
      console.warn('[mic] idle sweep', code, e instanceof Error ? e.message : e);
    } finally {
      await releaseLock(lockKey, token);
    }
  }
  return freed;
}

export function startMicIdleSweeper() {
  const iv = setInterval(() => {
    void sweepIdleMicSlots().catch((e) => console.warn('[mic] idle sweep', e instanceof Error ? e.message : e));
  }, 5_000);
  iv.unref?.();
}
