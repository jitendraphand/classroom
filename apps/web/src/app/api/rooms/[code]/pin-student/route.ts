import { z } from 'zod';
import { nudgeRoomState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { setStudentPinned } from '@/lib/sample';

/**
 * Teacher pins / unpins a student's video in the class panel. Persisted on the
 * participant (this class session), so it survives the teacher switching
 * device and the student re-joining. Students never see each other's video;
 * a pin only keeps the student's camera flowing to the teacher.
 */
const schema = z.object({
  participantId: z.string().min(1).max(64),
  pinned: z.boolean(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());
    const result = await setStudentPinned(code, body.participantId, body.pinned);
    if (!result.ok) {
      if (result.reason === 'not_student') return jsonError('Student is not in the class', 404);
      if (result.reason === 'full') {
        return jsonError(
          `All ${result.max} video slots are pinned. Unpin a student or show more videos first.`,
          409,
          { reason: 'pins_full', max: result.max }
        );
      }
      return jsonError('Class ended', 410);
    }
    nudgeRoomState(room.code, 'all');
    return jsonOk(result);
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Pin failed', 500);
  }
}
