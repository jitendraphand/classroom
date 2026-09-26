import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveRoomAccess, getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

const schema = z.union([
  z.object({
    raised: z.boolean(),
  }),
  z.object({
    participantId: z.string().min(1),
    raised: z.boolean(),
  }),
]);

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());
    const redis = await ensureRedis();
    const access = await resolveRoomAccess(room, { forceStudent });

    // Teacher lowering (or raising) a specific student's hand
    if ('participantId' in body) {
      const teacher = await getTeacherSession();
      if (!teacher || room.teacherId !== teacher.id || access.mode === 'student') {
        return jsonError('Unauthorized', 401);
      }
      const participant = await prisma.participant.findFirst({
        where: { id: body.participantId, roomId: room.id, role: 'STUDENT' },
        select: { id: true },
      });
      if (!participant) return jsonError('Participant not found', 404);
      if (body.raised) await redis.sadd(keys.hands(code), participant.id);
      else await redis.srem(keys.hands(code), participant.id);
      return jsonOk({ ok: true, raised: body.raised, participantId: participant.id });
    }

    // Student toggles own hand
    if (access.mode !== 'student' || !access.student) {
      return jsonError('Unauthorized', 401);
    }
    const me = access.student;
    if (me.roomId !== room.id || me.role !== 'STUDENT' || me.status !== 'ADMITTED') {
      return jsonError('Not admitted', 403);
    }

    if (body.raised) await redis.sadd(keys.hands(code), me.id);
    else await redis.srem(keys.hands(code), me.id);

    return jsonOk({ ok: true, raised: body.raised, participantId: me.id });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Hand update failed', 500);
  }
}
