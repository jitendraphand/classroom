import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { pinSpeaker, unpinSpeakerByParticipant } from '@/lib/sample';

const schema = z.object({
  identity: z.string().min(1).max(200),
  /** Omit or set false to release a sticky speak-pin (e.g. student self-muted). */
  pinned: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  try {
    const body = schema.parse(await req.json());

    if (body.pinned === false) {
      // Release the sticky pin. The student keeps their slot for this rotation
      // and is treated as an ordinary rotation candidate again.
      const result = await unpinSpeakerByParticipant(code, body.identity);
      return jsonOk({ ...result, identity: body.identity });
    }

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
