import { z } from 'zod';
import { roomRowCached } from '@/lib/roomStateCache';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { applyCameraReport } from '@/lib/teacherMute';

/**
 * Student reports their camera on / off (on change, and again on reconnect).
 * The teacher may only unmute students whose camera is on; a student who
 * turns the camera off while unmuted is muted here (lib/speakingRules).
 */
const schema = z.object({ on: z.boolean() });

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent = url.searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';
  const room = await roomRowCached(code);
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Invalid input');

  const access = await resolveRoomAccess(room, { forceStudent });
  if (access.mode !== 'student' || !access.student) return jsonError('Unauthorized', 401);
  const me = access.student;
  if (me.roomId !== room.id || me.role !== 'STUDENT') return jsonError('Not a student', 403);

  const { autoMuted } = await applyCameraReport(room, me, parsed.data.on);
  return jsonOk({ ok: true, autoMuted });
}
