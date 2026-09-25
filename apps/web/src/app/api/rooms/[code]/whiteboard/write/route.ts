import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

export const dynamic = 'force-dynamic';

const schema = z.object({
  allowed: z.boolean(),
});

const TTL = 60 * 60 * 6;

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = params.code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });

  try {
    const body = schema.parse(await req.json());
    const redis = await ensureRedis();
    if (body.allowed) {
      await redis.set(keys.wbWrite(code), '1', 'EX', TTL);
    } else {
      await redis.del(keys.wbWrite(code));
    }
    return jsonOk({ ok: true, allowed: body.allowed });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Write permission update failed', 500);
  }
}
