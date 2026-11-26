import type { Prisma, Room } from '@prisma/client';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { clampMaxVisible, rotateVisibleSample } from './sample';
import { markAdmitted } from './attendanceService';
import { directEntryAllowed, shouldAutoAdmit } from './admissionLogic';

type WaitingWhere = Prisma.ParticipantWhereInput;

/** WAITING → ADMITTED for these rows; returns the ids this call admitted. */
async function flipToAdmitted(where: WaitingWhere): Promise<string[]> {
  const waiting = await prisma.participant.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const ids = waiting.map((p) => p.id);
  if (!ids.length) return [];
  // `where` keeps status WAITING, so a seat admitted concurrently is not counted twice.
  await prisma.participant.updateMany({ where: { ...where, id: { in: ids } }, data: { status: 'ADMITTED' } });
  return ids;
}

/**
 * The teacher admitted these students: an earlier Deny / Remove in this class
 * session no longer blocks their direct entry (lib/admissionLogic
 * directEntryAllowed). School-app students are matched by student and class
 * session; manual/test joins (no student record) by name in the room.
 */
async function clearRemovals(roomId: string, admittedIds: string[]): Promise<void> {
  const rows = await prisma.participant.findMany({
    where: { id: { in: admittedIds } },
    select: { studentId: true, classSessionId: true, displayName: true },
  });
  const ors: Prisma.ParticipantWhereInput[] = rows.map((r) =>
    r.studentId
      ? { studentId: r.studentId, classSessionId: r.classSessionId }
      : { studentId: null, displayName: r.displayName }
  );
  if (!ors.length) return;
  await prisma.participant.updateMany({
    where: { roomId, removedByTeacher: true, OR: ors },
    data: { removedByTeacher: false },
  });
}

/**
 * Admit waiting students (ids, or every waiting student with `all`).
 *
 * - Classes have no size limit: every waiting student asked for is admitted.
 * - The Redis waiting / admitted sets are updated incrementally (SREM/SADD of
 *   the admitted ids). Rebuilding them from two full roster reads on every
 *   admit was O(class size) per student and lost concurrent updates.
 * - The camera sample is only re-drawn while it has a free slot.
 *
 * Admitted students keep `mutedByTeacher` (they join muted).
 */
export async function admitWaiting(
  room: Pick<Room, 'id' | 'code' | 'status'> & Partial<Pick<Room, 'maxVisibleVideos'>>,
  opts: { ids?: string[]; all?: boolean }
) {
  const where: WaitingWhere = opts.all
    ? { roomId: room.id, role: 'STUDENT', status: 'WAITING' }
    : { roomId: room.id, role: 'STUDENT', status: 'WAITING', id: { in: opts.ids || [] } };
  if (!opts.all && !opts.ids?.length) return 0;

  const ids = await flipToAdmitted(where);
  if (ids.length === 0) return 0;

  await clearRemovals(room.id, ids).catch((e) => console.error('admit: clear removals', e));
  await markAdmitted(ids).catch((e) => console.error('attendance admit', e));

  if (room.status === 'WAITING') {
    await prisma.room.updateMany({ where: { id: room.id, status: 'WAITING' }, data: { status: 'LIVE' } });
  }

  const redis = await ensureRedis();
  await redis
    .multi()
    .srem(keys.waiting(room.code), ...ids)
    .sadd(keys.admitted(room.code), ...ids)
    .exec();

  // A full sample stays as it is (rotation brings newcomers in); a sample with
  // a free slot takes the new students right away.
  const max = clampMaxVisible(room.maxVisibleVideos);
  if ((await redis.scard(keys.visible(room.code))) < max) await rotateVisibleSample(room.code);
  return ids.length;
}

/** Lobby polls retry direct entry for one seat at most this often (races, transient errors). */
export const DIRECT_ENTRY_RETRY_S = 10;

/**
 * Direct entry for a seat that is still waiting (called from the lobby's
 * /state poll). Catches the cases arrival alone misses: the student arrived
 * while the teacher was switching the waiting room off (the toggle's
 * "admit everyone waiting" did not see the new seat yet), or admitting on
 * arrival failed (a database or Redis hiccup). Same rule as on arrival: never for a
 * student the teacher denied or removed in this session. Returns true when
 * this call admitted the seat.
 */
export async function admitIfDirectEntry(
  room: Pick<Room, 'id' | 'code' | 'status' | 'waitingRoomOn'> & Partial<Pick<Room, 'maxVisibleVideos'>>,
  seat: { id: string; roomId: string; role: string; status: string; studentId: string | null; classSessionId: string | null; displayName: string },
): Promise<boolean> {
  if (seat.roomId !== room.id || !shouldAutoAdmit(room, seat)) return false;
  try {
    const redis = await ensureRedis();
    // Throttle per seat: many waiting students must not each run the
    // earlier-seats query on every 3-second lobby poll.
    if ((await redis.set(`directentry:try:${seat.id}`, '1', 'EX', DIRECT_ENTRY_RETRY_S, 'NX')) !== 'OK') return false;
  } catch {
    return false; // Redis down: arrival-time direct entry still applies
  }
  const earlier = await prisma.participant.findMany({
    where: seat.studentId
      ? { roomId: room.id, studentId: seat.studentId, classSessionId: seat.classSessionId }
      : { roomId: room.id, role: 'STUDENT', studentId: null, displayName: seat.displayName },
    select: { removedByTeacher: true },
  });
  if (!directEntryAllowed(earlier)) return false;
  return (await admitWaiting(room, { ids: [seat.id] })) > 0;
}
