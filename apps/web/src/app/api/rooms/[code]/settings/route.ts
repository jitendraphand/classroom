import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { rotateVisibleSample } from '@/lib/sample';

const schema = z.object({
  maxVisibleVideos: z.number().int().min(1).max(50),
  name: z.string().min(1).max(120).optional(),
});

export async function PATCH(req: Request, { params }: { params: { code: string } }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  try {
    const body = schema.parse(await req.json());
    const updated = await prisma.room.update({
      where: { id: room.id },
      data: {
        maxVisibleVideos: body.maxVisibleVideos,
        ...(body.name ? { name: body.name.trim() } : {}),
      },
    });
    await rotateVisibleSample(code, updated.maxVisibleVideos);
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
