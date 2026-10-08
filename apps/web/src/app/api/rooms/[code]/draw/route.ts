import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getAdminSession, resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { cleanPoints, isDrawColor, validStrokeId } from '@/lib/drawLogic';
import {
  DrawError,
  allowDraw,
  appendPoints,
  clearDrawing,
  currentHolder,
  deleteOwnStroke,
  listStrokes,
  revokeDraw,
  setDrawRequest,
} from '@/lib/drawServer';

export const dynamic = 'force-dynamic';

/**
 * Student drawing on the teacher's shared screen (lib/drawLogic.ts).
 *
 * GET: current holder + strokes (late joiners), for the teacher, admitted
 * students and admin observers.
 *
 * POST `{ action }`:
 * - student: `request` / `cancel` (like a raised hand), `release` (stop
 *   drawing), `pts` (append points to own stroke), `del` (eraser / undo of an
 *   own stroke);
 * - teacher: `allow` / `revoke` (`participantId`), `clear` (wipe the drawing).
 */
const schema = z.object({
  action: z.enum(['request', 'cancel', 'release', 'pts', 'del', 'allow', 'revoke', 'clear']),
  participantId: z.string().min(1).max(64).optional(),
  id: z.string().max(40).optional(),
  from: z.number().int().min(0).max(100_000).optional(),
  pts: z.array(z.number()).max(4000).optional(),
  color: z.string().max(10).optional(),
});

async function loadRoom(code: string) {
  return prisma.room.findUnique({ where: { code }, select: { id: true, code: true, teacherId: true, status: true } });
}

async function sharing(code: string) {
  return (await (await ensureRedis()).get(keys.stage(code))) === 'screen';
}

function wantsStudent(req: Request) {
  return new URL(req.url).searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await loadRoom(code);
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonOk({ holder: null, strokes: [] });
  const access = await resolveRoomAccess(room, { forceStudent: wantsStudent(req) });
  const studentOk = access.mode === 'student' && access.student?.status === 'ADMITTED';
  if (!access.isTeacher && !studentOk && !(await getAdminSession())) return jsonError('Unauthorized', 401);
  const redis = await ensureRedis();
  const [holder, strokes] = await Promise.all([currentHolder(code, redis), listStrokes(code, redis)]);
  return jsonOk({ holder, strokes });
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await loadRoom(code);
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.errors[0]?.message || 'Invalid input');
  const body = parsed.data;
  const teacherAction = body.action === 'allow' || body.action === 'revoke' || body.action === 'clear';
  const access = await resolveRoomAccess(room, { forceStudent: !teacherAction && wantsStudent(req) });

  try {
    if (teacherAction) {
      if (!access.teacherOwns) return jsonError('Unauthorized', 401);
      if (body.action === 'clear') {
        await clearDrawing(code);
        return jsonOk({ ok: true });
      }
      if (body.action === 'revoke') {
        await revokeDraw(code, { clear: true });
        if (body.participantId) await setDrawRequest(code, body.participantId, false);
        return jsonOk({ ok: true });
      }
      if (!body.participantId) return jsonError('participantId required');
      if (!(await sharing(code))) return jsonError('Share your screen first: students draw on the shared screen.', 409);
      const p = await prisma.participant.findFirst({
        where: { id: body.participantId, roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
        select: { id: true, livekitIdentity: true, displayName: true },
      });
      if (!p) return jsonError('Student not in class', 404);
      const holder = await allowDraw(code, p);
      return jsonOk({ ok: true, holder });
    }

    // Student actions.
    const me = access.mode === 'student' ? access.student : null;
    if (!me || me.roomId !== room.id || me.role !== 'STUDENT' || me.status !== 'ADMITTED') return jsonError('Not admitted', 403);

    if (body.action === 'request' || body.action === 'cancel') {
      if (body.action === 'request' && !(await sharing(code))) return jsonError('You can ask to draw while your teacher shares the screen.', 409);
      await setDrawRequest(code, me.id, body.action === 'request');
      return jsonOk({ ok: true });
    }

    const holder = await currentHolder(code);
    const mine = !!holder && holder.participantId === me.id;
    if (body.action === 'release') {
      if (mine) await revokeDraw(code, { clear: false });
      return jsonOk({ ok: true });
    }
    if (!mine || !holder) return jsonError('Not allowed to draw', 403);
    if (body.action === 'del') {
      if (!validStrokeId(body.id)) return jsonError('Bad stroke');
      await deleteOwnStroke(code, holder.identity, body.id);
      return jsonOk({ ok: true });
    }
    // pts
    if (!(await sharing(code))) return jsonError('The share stopped', 409);
    const pts = cleanPoints(body.pts);
    if (!validStrokeId(body.id) || !pts || !isDrawColor(body.color)) return jsonError('Bad stroke');
    await appendPoints(code, holder, { id: body.id, from: body.from ?? 0, pts, color: body.color });
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof DrawError) return jsonError(e.message, e.status);
    console.error('draw', e);
    return jsonError('Drawing update failed', 500);
  }
}
