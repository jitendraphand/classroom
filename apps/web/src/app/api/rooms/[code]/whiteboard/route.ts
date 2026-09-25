import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

export const dynamic = 'force-dynamic';

type AccessResult =
  | { ok: true; room: { id: string; code: string; status: string }; isTeacher: boolean }
  | { ok: false; reason: 'ended' | 'unauthorized' | 'not_found' };

async function canAccess(req: Request, code: string): Promise<AccessResult> {
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return { ok: false, reason: 'not_found' };
  if (room.status === 'ENDED') return { ok: false, reason: 'ended' };

  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });
  if (access.isTeacher) return { ok: true, room, isTeacher: true };
  if (
    access.mode === 'student' &&
    access.student &&
    access.student.roomId === room.id &&
    access.student.status === 'ADMITTED'
  ) {
    return { ok: true, room, isTeacher: false };
  }
  return { ok: false, reason: 'unauthorized' };
}

function deny(result: AccessResult) {
  if (result.ok) return null;
  if (result.reason === 'ended') return jsonError('Class ended', 410, { ended: true });
  if (result.reason === 'not_found') return jsonError('Room not found', 404);
  return jsonError('Unauthorized', 401);
}

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const result = await canAccess(req, code);
  const err = deny(result);
  if (err) return err;
  const redis = await ensureRedis();
  const snapshot = await redis.get(keys.whiteboard(code));
  const wbWrite = (await redis.get(keys.wbWrite(code))) === '1';
  const canWrite = result.ok && (result.isTeacher || wbWrite);
  return jsonOk({
    snapshot: snapshot ? JSON.parse(snapshot) : null,
    canWrite,
  });
}

export async function PUT(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const result = await canAccess(req, code);
  const err = deny(result);
  if (err) return err;

  if (result.ok && !result.isTeacher) {
    const redis = await ensureRedis();
    const wbWrite = (await redis.get(keys.wbWrite(code))) === '1';
    if (!wbWrite) {
      return jsonError('Whiteboard is view-only', 403);
    }
  }

  try {
    const body = await req.json();
    const redis = await ensureRedis();
    await redis.set(keys.whiteboard(code), JSON.stringify(body.snapshot ?? body), 'EX', 60 * 60 * 6);
    return jsonOk({ ok: true });
  } catch (e) {
    console.error(e);
    return jsonError('Save failed', 500);
  }
}
