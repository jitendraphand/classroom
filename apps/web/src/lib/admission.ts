import type { Prisma, Room } from '@prisma/client';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { clampMaxVisible, rotateVisibleSample } from './sample';
import { markAdmitted } from './attendanceService';
import { CLASS_FULL_MESSAGE, classCapacity, seatsLeft } from './capacity';
import { getSchoolSettings } from './schoolSettings';
import { directEntryAllowed, shouldAutoAdmit } from './admissionLogic';

export class ClassFullError extends Error {
  constructor() {
    super(CLASS_FULL_MESSAGE);
    this.name = 'ClassFullError';
  }
}

type Tx = Prisma.TransactionClient;
type WaitingWhere = Prisma.ParticipantWhereInput;

/** WAITING → ADMITTED for these rows; returns the ids this call admitted. */
async function flipToAdmitted(tx: Tx, where: WaitingWhere, limit: number | null): Promise<string[]> {
  const waiting = await tx.participant.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const ids = (limit == null ? waiting : waiting.slice(0, limit)).map((p) => p.id);
  if (!ids.length) return [];
  await tx.participant.updateMany({ where: { ...where, id: { in: ids } }, data: { status: 'ADMITTED' } });
  return ids;
}

/**
 * Admit waiting students (ids, or every waiting student with `all`).
 *
 * - With a class-size cap, the count-then-admit runs under a per-room
 *   Postgres advisory lock, so concurrent admits (teacher clicks, waiting room
 *   off and students arriving at once) cannot overshoot the cap.
 * - The Redis waiting / admitted sets are updated incrementally (SREM/SADD of
 *   the admitted ids). Rebuilding them from two full roster reads on every
 *   admit was O(class size) per student and lost concurrent updates.
 * - The camera sample is only re-drawn while it has a free slot.
 *
 * Admitted students keep `mutedByTeacher` (they join muted).
 */
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

export async function admitWaiting(
  room: Pick<Room, 'id' | 'code' | 'status'> & Partial<Pick<Room, 'maxVisibleVideos'>>,
  opts: { ids?: string[]; all?: boolean }
) {
  const where: WaitingWhere = opts.all
    ? { roomId: room.id, role: 'STUDENT', status: 'WAITING' }
    : { roomId: room.id, role: 'STUDENT', status: 'WAITING', id: { in: opts.ids || [] } };
  if (!opts.all && !opts.ids?.length) return 0;

  const settings = await getSchoolSettings();
  const cap = classCapacity(settings.maxStudentsPerClass);

  let ids: string[];
  if (cap == null) {
    ids = await flipToAdmitted(prisma, where, null);
  } else {
    ids = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`admit:${room.id}`}))`;
      const pending = await tx.participant.count({ where });
      if (!pending) return [];
      const admittedCount = await tx.participant.count({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
      });
      const seats = seatsLeft(cap, admittedCount, pending);
      if (seats.full) throw new ClassFullError();
      return flipToAdmitted(tx, where, seats.admit);
    });
  }
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

/** Lobby polls retry direct entry for one seat at most this often (class full, races). */
export const DIRECT_ENTRY_RETRY_S = 10;

/**
 * Direct entry for a seat that is still waiting (called from the lobby's
 * /state poll). Catches the cases arrival alone misses: the student arrived
 * while the teacher was switching the waiting room off (the toggle's
 * "admit everyone waiting" did not see the new seat yet), or the class was
 * full and a place has since freed up. Same rule as on arrival: never for a
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
    // Throttle per seat: a full class with many waiting students must not run
    // an admit transaction on every 3-second lobby poll.
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
  try {
    return (await admitWaiting(room, { ids: [seat.id] })) > 0;
  } catch (e) {
    if (e instanceof ClassFullError) return false;
    throw e;
  }
}
