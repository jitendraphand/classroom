import { z } from 'zod';
import { nudgeRoomState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { admitWaiting, ClassFullError } from '@/lib/admission';
import { CLASS_FULL_MESSAGE } from '@/lib/capacity';

const schema = z.object({
  participantIds: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());
    const count = await admitWaiting(room, { ids: body.participantIds, all: body.all });

    // Admitted students are still in the lobby (not on LiveKit: they see the
    // admit on their lobby poll); the class's other students are unaffected.
    nudgeRoomState(room.code, 'teacher');
    return jsonOk({ admitted: count, roomStatus: 'LIVE' });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof ClassFullError) return jsonError(CLASS_FULL_MESSAGE, 409);
    console.error(e);
    return jsonError('Admit failed', 500);
  }
}
