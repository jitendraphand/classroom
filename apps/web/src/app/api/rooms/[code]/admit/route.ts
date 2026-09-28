import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { rotateVisibleSample } from '@/lib/sample';

const schema = z.object({
  participantIds: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());
    const where = body.all
      ? { roomId: room.id, role: 'STUDENT' as const, status: 'WAITING' as const }
      : {
          roomId: room.id,
          role: 'STUDENT' as const,
          status: 'WAITING' as const,
          id: { in: body.participantIds || [] },
        };

    const updated = await prisma.participant.updateMany({
      where,
      data: { status: 'ADMITTED' },
    });

    if (room.status === 'WAITING') {
      await prisma.room.update({ where: { id: room.id }, data: { status: 'LIVE' } });
    }

    const admitted = await prisma.participant.findMany({
      where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
      select: { id: true },
    });

    const redis = await ensureRedis();
    const pipe = redis.multi();
    pipe.del(keys.waiting(code));
    const stillWaiting = await prisma.participant.findMany({
      where: { roomId: room.id, role: 'STUDENT', status: 'WAITING' },
      select: { id: true },
    });
    if (stillWaiting.length) pipe.sadd(keys.waiting(code), ...stillWaiting.map((p) => p.id));
    pipe.del(keys.admitted(code));
    if (admitted.length) pipe.sadd(keys.admitted(code), ...admitted.map((p) => p.id));
    await pipe.exec();

    await rotateVisibleSample(code);

    return jsonOk({ admitted: updated.count, roomStatus: 'LIVE' });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Admit failed', 500);
  }
}
