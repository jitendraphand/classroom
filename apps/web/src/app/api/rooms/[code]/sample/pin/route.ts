import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { pinSpeaker } from '@/lib/sample';

const schema = z.object({
  identity: z.string().min(1).max(200),
});

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  try {
    const body = schema.parse(await req.json());
    const result = await pinSpeaker(code, body.identity);
    if (!result.ok && result.reason === 'not_student') {
      return jsonError('Participant is not an admitted student', 404);
    }
    return jsonOk(result);
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Pin failed', 500);
  }
}
