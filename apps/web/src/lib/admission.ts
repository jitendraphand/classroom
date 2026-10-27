import type { Prisma, Room } from '@prisma/client';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { clampMaxVisible, rotateVisibleSample } from './sample';
import { markAdmitted } from './attendanceService';
import { CLASS_FULL_MESSAGE, classCapacity, seatsLeft } from './capacity';
import { getSchoolSettings } from './schoolSettings';

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
