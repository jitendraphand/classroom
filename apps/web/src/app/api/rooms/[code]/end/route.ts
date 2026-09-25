import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { roomService, livekitRoomName } from '@/lib/livekit';

export async function POST(_req: Request, { params }: { params: { code: string } }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  await prisma.room.update({
    where: { id: room.id },
    data: { status: 'ENDED', endedAt: new Date() },
  });
  await prisma.participant.updateMany({
    where: { roomId: room.id, status: { not: 'LEFT' } },
    data: { status: 'LEFT', leftAt: new Date() },
  });

  const redis = await ensureRedis();
  await redis.del(
    keys.waiting(code),
    keys.admitted(code),
    keys.visible(code),
    keys.muted(code),
    keys.rotation(code),
    keys.whiteboard(code)
  );

  try {
    await roomService().deleteRoom(livekitRoomName(code));
  } catch (e) {
    console.warn('LiveKit deleteRoom', e);
  }

  return jsonOk({ ok: true });
}
