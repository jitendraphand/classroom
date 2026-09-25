import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { rotateVisibleSample } from '@/lib/sample';

const schema = z.object({ code: z.string().min(4).max(12) });

export async function POST(req: Request) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  try {
    const body = schema.parse(await req.json());
    const code = body.code.toUpperCase();
    const room = await prisma.room.findUnique({ where: { code } });
    if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
    const result = await rotateVisibleSample(code);
    return jsonOk(result);
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Rotation failed', 500);
  }
}
