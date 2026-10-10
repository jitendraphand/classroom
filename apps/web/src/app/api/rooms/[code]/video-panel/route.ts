import { z } from 'zod';
import { nudgeRoomState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { VIDEO_PANEL_TTL_S } from '@/lib/camOnDemand';

export const dynamic = 'force-dynamic';

const schema = z.object({ open: z.boolean() });

/**
 * Teacher's student-video panel shown (true) or minimized / closed (false).
 * Students in the visible sample publish their camera only while it is shown
 * (state `me.camWanted`). No key = shown, so clients that never call this
 * (the Windows teacher app) keep the old behaviour.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code }, select: { teacherId: true, status: true } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Invalid input');
  const redis = await ensureRedis();
  const prev = (await redis.get(keys.videoPanel(code))) !== '0';
  if (parsed.data.open) await redis.del(keys.videoPanel(code));
  else await redis.set(keys.videoPanel(code), '0', 'EX', VIDEO_PANEL_TTL_S);
  if (prev !== parsed.data.open) nudgeRoomState(code, 'all');
  return jsonOk({ ok: true, open: parsed.data.open });
}
