import type { Prisma, Room } from '@prisma/client';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { clampMaxVisible, rotateVisibleSample } from './sample';
import { markAdmitted } from './attendanceService';
import { shouldAutoAdmit } from './admissionLogic';

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
 * Admit student seats not yet in (ids, or all of them with `all`): called on
 * arrival (lib/studentService, the manual join) and by the joining page's poll.
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
 * Safety net for a seat still not in (called from the joining page's /state
 * poll): admitting on arrival failed (a database or Redis hiccup) or raced.
 * Returns true when this call admitted the seat.
 */
export async function admitIfDirectEntry(
  room: Pick<Room, 'id' | 'code' | 'status'> & Partial<Pick<Room, 'maxVisibleVideos'>>,
  seat: { id: string; roomId: string; role: string; status: string; studentId: string | null; classSessionId: string | null; displayName: string },
): Promise<boolean> {
  if (seat.roomId !== room.id || !shouldAutoAdmit(room, seat)) return false;
  try {
    const redis = await ensureRedis();
    // Throttle per seat: a joining page polls every few seconds.
    if ((await redis.set(`directentry:try:${seat.id}`, '1', 'EX', DIRECT_ENTRY_RETRY_S, 'NX')) !== 'OK') return false;
  } catch {
    return false; // Redis down: arrival-time direct entry still applies
  }
  return (await admitWaiting(room, { ids: [seat.id] })) > 0;
}
