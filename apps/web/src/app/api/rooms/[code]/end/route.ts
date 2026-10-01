import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { endRoom } from '@/lib/teacherRoom';

export async function POST(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  await endRoom(room);
  return jsonOk({ ok: true });
}
