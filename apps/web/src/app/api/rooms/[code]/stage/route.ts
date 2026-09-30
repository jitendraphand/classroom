import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys, type StageMode } from '@/lib/redis';

export const dynamic = 'force-dynamic';

const schema = z.object({
  mode: z.enum(['idle', 'screen']),
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
    await redis.set(keys.stage(code), mode, 'EX', STAGE_TTL);

    // Annotations belong to the share session. Leaving screen must wipe them.
    if (mode !== 'screen') {
      await redis.del(keys.annotate(code));
    }

    return jsonOk({ ok: true, stageMode: mode });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Stage update failed', 500);
  }
}
