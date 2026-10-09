import { z } from 'zod';
import { nudgeRoomState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys, type StageMode } from '@/lib/redis';
import { endDrawingSession } from '@/lib/drawServer';

export const dynamic = 'force-dynamic';

const schema = z.object({
  mode: z.enum(['idle', 'screen']),
  /**
   * The sharing app draws student ink on the teacher's real desktop, so it is
   * already in the shared picture (Windows teacher app). Viewers then skip
   * their own stroke overlay (no double drawing). Browsers never send it.
   */
  desktopInk: z.boolean().optional(),
});

const STAGE_TTL = 60 * 60 * 6;

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });

  try {
    const body = schema.parse(await req.json());
    const mode: StageMode = body.mode;
    const redis = await ensureRedis();
    const prev = await redis.get(keys.stage(code));
    await redis.set(keys.stage(code), mode, 'EX', STAGE_TTL);
    if (mode === 'screen' && body.desktopInk === true) await redis.set(keys.desktopInk(code), '1', 'EX', STAGE_TTL);
    else await redis.del(keys.desktopInk(code));
    // Share stopped: drawing permission ends and the drawing is wiped.
    if (mode === 'idle' && prev === 'screen') await endDrawingSession(code);

    nudgeRoomState(room.code, 'all');
    return jsonOk({ ok: true, stageMode: mode, desktopInk: mode === 'screen' && body.desktopInk === true });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Stage update failed', 500);
  }
}
