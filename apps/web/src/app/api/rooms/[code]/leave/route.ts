import { prisma } from '@/lib/db';
import { getStudentParticipant, clearStudentCookie, getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { rotateVisibleSample } from '@/lib/sample';
import { z } from 'zod';

const schema = z.object({
  participantId: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);

  let participantId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    participantId = schema.parse(body).participantId;
  } catch {
    /* empty */
  }

  const teacher = await getTeacherSession();
  const self = await getStudentParticipant();

  let target = self;
  if (participantId && teacher && room.teacherId === teacher.id) {
    target = await prisma.participant.findFirst({
      where: { id: participantId, roomId: room.id },
      include: { room: true },
    });
  }

  if (!target || target.roomId !== room.id) return jsonError('Not in room', 403);

  await prisma.participant.update({
    where: { id: target.id },
    data: { status: 'LEFT', leftAt: new Date() },
  });

  const redis = await ensureRedis();
  await redis.srem(keys.waiting(code), target.id);
  await redis.srem(keys.admitted(code), target.id);
  await redis.srem(keys.visible(code), target.livekitIdentity);
  await redis.srem(keys.hands(code), target.id);

  if (self && self.id === target.id) clearStudentCookie();

  if (target.role === 'STUDENT') {
    await rotateVisibleSample(code);
  }

  return jsonOk({ ok: true });
}
