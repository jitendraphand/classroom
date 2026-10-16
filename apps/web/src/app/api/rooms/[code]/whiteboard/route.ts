import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { holderFor } from '@/lib/drawServer';
import { allowReq, requestSnapshot, sanitizeStudentOps, sendWb, setWhiteboard, whiteboardOn } from '@/lib/whiteboardServer';

export const dynamic = 'force-dynamic';

/**
 * Whiteboard (lib/whiteboardServer.ts).
 * - teacher: `{ action: 'on' | 'off' }`
 * - admitted student / teacher: `{ action: 'req' }` → the teacher device sends a snapshot
 * - student allowed to draw: `{ action: 'ops', ops }` → relayed to everyone
 */
const schema = z.object({
  action: z.enum(['on', 'off', 'req', 'ops']),
  ops: z.array(z.unknown()).max(20).optional(),
});

function wantsStudent(req: Request) {
  return new URL(req.url).searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  return jsonOk({ on: await whiteboardOn(code) });
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.errors[0]?.message || 'Invalid input');
  const body = parsed.data;
  const access = await resolveRoomAccess(room, { forceStudent: wantsStudent(req) });
  const student = access.mode === 'student' && access.student?.status === 'ADMITTED' ? access.student : null;

  if (body.action === 'on' || body.action === 'off') {
    if (!access.isTeacher || student) return jsonError('Unauthorized', 401);
    await setWhiteboard(code, body.action === 'on');
    return jsonOk({ on: body.action === 'on' });
  }
  if (body.action === 'req') {
    const who = student;
    if (!who) return jsonError('Unauthorized', 401);
    if (!(await allowReq(`wbreq:${who.id}`))) return jsonError('Too many requests', 429);
    if (await whiteboardOn(code)) await requestSnapshot(code, who.livekitIdentity);
    return jsonOk({ ok: true });
  }
  // ops
  if (!student) return jsonError('Unauthorized', 401);
  if (!(await whiteboardOn(code))) return jsonError('The whiteboard is not open', 409);
  const holder = await holderFor(code, student.id);
  if (!holder) return jsonError('Ask your teacher to let you draw', 403);
  const ops = sanitizeStudentOps(body.ops, student.livekitIdentity);
  if (ops.length) await sendWb(code, { v: 1, t: 'ops', ops, by: student.livekitIdentity });
  return jsonOk({ ok: true, n: ops.length });
}

