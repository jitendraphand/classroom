import { z } from 'zod';
import { roomRowCached } from '@/lib/roomStateCache';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { recordStudentHeartbeat } from '@/lib/studentPresence';

/**
 * Admitted student heartbeat. A crash, kill, or network loss never sends
 * /presence left. A late beat shows "reconnecting" and does not drop the
 * roster; LiveKit leave does. Identity comes from the session, not the body.
 */
const schema = z.object({
  sid: z.string().min(1).max(120),
});

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';

  const room = await roomRowCached(code);
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Invalid input');

  const access = await resolveRoomAccess(room, { forceStudent });
  if (access.mode !== 'student' || !access.student) return jsonError('Unauthorized', 401);
  const me = access.student;
  if (me.roomId !== room.id || me.role !== 'STUDENT' || me.status !== 'ADMITTED') {
    return jsonError('Not admitted', 403);
  }
  if (!me.livekitIdentity.startsWith('student_')) return jsonError('Not a student', 400);

  await recordStudentHeartbeat(code, me.livekitIdentity, parsed.data.sid);
  return jsonOk({ ok: true });
}
