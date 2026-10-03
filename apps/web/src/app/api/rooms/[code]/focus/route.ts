import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { encodeFocus, FOCUS_STATUSES, type FocusStatus } from '@/lib/focusStatus';

/**
 * A student reports their own fullscreen / focus status (left fullscreen,
 * switched away, back, or iPhone without the Fullscreen API). The teacher
 * reads it from /state. HTTP rather than LiveKit: students hold no data or
 * metadata publish grants.
 */
const schema = z.object({
  status: z.enum(FOCUS_STATUSES as unknown as [FocusStatus, ...FocusStatus[]]),
  iphone: z.boolean().optional(),
});

/** Same lifetime as other per-class keys; refreshed on every report. */
const TTL_SECONDS = 60 * 60 * 6;

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return jsonError('Invalid input');
  }

  const access = await resolveRoomAccess(room, { forceStudent });
  if (access.mode !== 'student' || !access.student) return jsonError('Unauthorized', 401);
  const me = access.student;
  if (me.roomId !== room.id || me.role !== 'STUDENT' || me.status !== 'ADMITTED') {
    return jsonError('Not admitted', 403);
  }

  try {
    const redis = await ensureRedis();
    await redis.hset(keys.focus(code), me.id, encodeFocus(body.status, !!body.iphone, Date.now()));
    await redis.expire(keys.focus(code), TTL_SECONDS);
    return jsonOk({ ok: true, status: body.status });
  } catch (e) {
    console.error(e);
    return jsonError('Focus update failed', 500);
  }
}
