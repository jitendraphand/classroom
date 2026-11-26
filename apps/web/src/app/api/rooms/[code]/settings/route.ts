import { z } from 'zod';
import { nudgeRoomState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, rotateVisibleSample } from '@/lib/sample';

const schema = z.object({
  maxVisibleVideos: z.number().int().min(1).max(6).optional(),
  name: z.string().min(1).max(120).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  try {
    const body = schema.parse(await req.json());
    const updated = await prisma.room.update({
      where: { id: room.id },
      data: {
        ...(body.maxVisibleVideos !== undefined ? { maxVisibleVideos: clampMaxVisible(body.maxVisibleVideos) } : {}),
        ...(body.name ? { name: body.name.trim() } : {}),
      },
    });
    if (body.maxVisibleVideos !== undefined) await rotateVisibleSample(code, updated.maxVisibleVideos);
    nudgeRoomState(room.code, 'all');
    return jsonOk({
      maxVisibleVideos: updated.maxVisibleVideos,
      name: updated.name,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Update failed', 500);
  }
}
