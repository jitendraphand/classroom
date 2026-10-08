import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/adminGuard';
import { normalizeCampus, normalizeDivision, normalizeGrade } from '@/lib/grades';
import { z } from 'zod';
import { jsonError } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { livekitRoomName, removeLiveKitParticipant } from '@/lib/livekit';
import { nudgeRoomState } from '@/lib/roomNudge';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/** Known students (first signed join or roster import), filterable. */
export async function GET(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  const url = new URL(req.url);
  const campus = url.searchParams.get('campus');
  const grade = url.searchParams.get('grade');
  const division = url.searchParams.get('division');
  const q = url.searchParams.get('q')?.trim();
  const where = {
    deletedAt: null,
    ...(campus ? { campus: normalizeCampus(campus) } : {}),
    ...(grade ? { grade: normalizeGrade(grade) } : {}),
    ...(division ? { division: normalizeDivision(division) } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { externalId: { contains: q } },
            { rollNumber: { equals: q } },
          ],
        }
      : {}),
  };
  const [total, students, groups] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      orderBy: [{ campus: 'asc' }, { grade: 'asc' }, { division: 'asc' }, { rollNumber: 'asc' }, { name: 'asc' }],
      take: 500,
      select: { id: true, externalId: true, name: true, campus: true, grade: true, division: true, rollNumber: true, source: true, lastSeenAt: true },
    }),
    prisma.student.groupBy({
      by: ['campus', 'grade', 'division'],
      where: { deletedAt: null },
      _count: { _all: true },
      orderBy: [{ campus: 'asc' }, { grade: 'asc' }, { division: 'asc' }],
    }),
  ]);
  return jsonOk({
    total,
    students,
    groups: groups.map((g) => ({ campus: g.campus, grade: g.grade, division: g.division, count: g._count._all })),
  });
}

const deleteSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Admin: delete a student (soft delete). Hidden from lists, reports'
 * "known students" after the deletion and new rosters; attendance history
 * stays. Their open class seats end now. Joining again from the school app
 * (or a roster import) restores the student.
 */
export async function DELETE(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Student id required');
  const st = await prisma.student.findUnique({ where: { id: parsed.data.id } });
  if (!st || st.deletedAt) return jsonError('Student not found', 404);
  const now = new Date();
  const seats = await prisma.participant.findMany({
    where: { studentId: st.id, status: { not: 'LEFT' } },
    select: { id: true, livekitIdentity: true, room: { select: { code: true, sessionId: true, status: true } } },
  });
  await prisma.$transaction([
    prisma.student.update({ where: { id: st.id }, data: { deletedAt: now } }),
    prisma.participant.updateMany({
      where: { studentId: st.id, status: { not: 'LEFT' } },
      data: { status: 'LEFT', leftAt: now },
    }),
  ]);
  for (const seat of seats) {
    if (seat.room.status === 'ENDED') continue;
    try {
      const redis = await ensureRedis();
      await redis.srem(keys.waiting(seat.room.code), seat.id);
      await redis.srem(keys.admitted(seat.room.code), seat.id);
    } catch {
      /* best effort */
    }
    await removeLiveKitParticipant(livekitRoomName(seat.room.code, seat.room.sessionId), seat.livekitIdentity);
    nudgeRoomState(seat.room.code, 'all');
  }
  return jsonOk({ ok: true, name: st.name, externalId: st.externalId });
}
