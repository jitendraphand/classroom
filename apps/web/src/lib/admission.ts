import type { Room } from '@prisma/client';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { rotateVisibleSample } from './sample';
import { markAdmitted } from './attendanceService';

/**
 * Admit waiting students (ids, or every waiting student with `all`). Keeps the
 * Redis waiting / admitted sets in sync, records attendance and refreshes the
 * camera sample. Admitted students keep `mutedByTeacher` (they join muted).
 */
export async function admitWaiting(room: Pick<Room, 'id' | 'code' | 'status'>, opts: { ids?: string[]; all?: boolean }) {
  const where = opts.all
    ? { roomId: room.id, role: 'STUDENT' as const, status: 'WAITING' as const }
    : { roomId: room.id, role: 'STUDENT' as const, status: 'WAITING' as const, id: { in: opts.ids || [] } };

  const toAdmit = await prisma.participant.findMany({ where, select: { id: true } });
  if (toAdmit.length === 0 && !opts.all) return 0;
  const updated = await prisma.participant.updateMany({
    where: { ...where, id: { in: toAdmit.map((p) => p.id) } },
    data: { status: 'ADMITTED' },
  });
  await markAdmitted(toAdmit.map((p) => p.id)).catch((e) => console.error('attendance admit', e));

  if (room.status === 'WAITING') {
    await prisma.room.update({ where: { id: room.id }, data: { status: 'LIVE' } });
  }

  const [admitted, stillWaiting] = await Promise.all([
    prisma.participant.findMany({ where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' }, select: { id: true } }),
    prisma.participant.findMany({ where: { roomId: room.id, role: 'STUDENT', status: 'WAITING' }, select: { id: true } }),
  ]);
  const redis = await ensureRedis();
  const pipe = redis.multi();
  pipe.del(keys.waiting(room.code));
  if (stillWaiting.length) pipe.sadd(keys.waiting(room.code), ...stillWaiting.map((p) => p.id));
  pipe.del(keys.admitted(room.code));
  if (admitted.length) pipe.sadd(keys.admitted(room.code), ...admitted.map((p) => p.id));
  await pipe.exec();

  await rotateVisibleSample(room.code);
  return updated.count;
}
