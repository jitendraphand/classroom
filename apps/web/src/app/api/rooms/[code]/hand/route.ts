import { z } from 'zod';
import { nudgeRoomState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { resolveRoomAccess, getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

/**
 * A student raises/lowers their own hand by sending only `raised`; the teacher
 * targets a specific student by also sending `participantId`.
 *
 * This is deliberately a single object with an optional field rather than a
 * `z.union`. zod objects strip unknown keys, so `{ participantId, raised:false }`
 * also validates against a bare `{ raised }` branch, and a union would always
 * resolve to that first branch — silently dropping `participantId` and making
 * the teacher's "lower hand" action fail with a 401.
 */
const schema = z.object({
  raised: z.boolean(),
  /** Present => teacher-issued action against one student in this room. */
  participantId: z.string().min(1).optional(),
});

export const dynamic = 'force-dynamic';

/** Raise / lower, remembering when the hand went up (first raise wins) so the roster orders by it. */
async function setHand(redis: Awaited<ReturnType<typeof ensureRedis>>, code: string, id: string, raised: boolean) {
  if (raised) {
    await redis.multi().sadd(keys.hands(code), id).hsetnx(keys.handsAt(code), id, String(Date.now())).exec();
  } else {
    await redis.multi().srem(keys.hands(code), id).hdel(keys.handsAt(code), id).exec();
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());
    const redis = await ensureRedis();

    // Teacher lowering (or raising) a specific student's hand — authorize like
    // mute (getTeacherSession only). Do not fail on access.mode === 'student'
    // from as=student / x-classroom-as headers that roomFetch may send.
    if (body.participantId) {
      const teacher = await getTeacherSession();
      if (!teacher || room.teacherId !== teacher.id) {
        return jsonError('Unauthorized', 401);
      }
      const participant = await prisma.participant.findFirst({
        where: { id: body.participantId, roomId: room.id, role: 'STUDENT' },
        select: { id: true },
      });
      if (!participant) return jsonError('Participant not found', 404);
      await setHand(redis, code, participant.id, body.raised);
      nudgeRoomState(room.code, 'all');
      return jsonOk({ ok: true, raised: body.raised, participantId: participant.id });
    }

    // Student toggles own hand
    const access = await resolveRoomAccess(room, { forceStudent });
    if (access.mode !== 'student' || !access.student) {
      return jsonError('Unauthorized', 401);
    }
    const me = access.student;
    if (me.roomId !== room.id || me.role !== 'STUDENT' || me.status !== 'ADMITTED') {
      return jsonError('Not admitted', 403);
    }

    await setHand(redis, code, me.id, body.raised);

    nudgeRoomState(room.code, 'teacher');
    return jsonOk({ ok: true, raised: body.raised, participantId: me.id });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Hand update failed', 500);
  }
}
