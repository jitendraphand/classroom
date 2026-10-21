import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { recordStudentConnection } from '@/lib/studentPresence';

/**
 * Teacher reports a LiveKit ParticipantConnected / ParticipantDisconnected
 * immediately, so the roster does not wait for the webhook (~15–20 s when the
 * student tab did not send leave).
 */
const schema = z.object({
  identity: z.string().min(1).max(120),
  sid: z.string().min(1).max(120),
  kind: z.enum(['joined', 'left']),
});

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Invalid presence event');
  if (!parsed.data.identity.startsWith('student_')) return jsonError('Not a student', 400);

  await recordStudentConnection(code, parsed.data.identity, parsed.data.kind, parsed.data.sid);
  return jsonOk({ ok: true });
}
