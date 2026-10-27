import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { nudgeRoomState, pushMuteState } from '@/lib/roomNudge';
import { getSchoolSettings } from '@/lib/schoolSettings';
import { readMicBook, writeMicBook } from '@/lib/micBook';
import { studentSetMic } from '@/lib/micSlots';
import { setParticipantMicAllowed } from '@/lib/livekit';
import { getVisibleSample } from '@/lib/sample';

export const dynamic = 'force-dynamic';

/**
 * Student "ask to speak" / release. When the school has no mic cap, this does
 * not unmute anyone — the teacher still controls mics.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  const access = await resolveRoomAccess(room, { forceStudent: true });
  const me = access.student;
  if (!me || me.roomId !== room.id || me.role !== 'STUDENT' || me.status !== 'ADMITTED') {
    return jsonError('Not admitted', 403);
  }

  const body = (await req.json().catch(() => null)) as { want?: unknown } | null;
  if (typeof body?.want !== 'boolean') return jsonError('want must be true or false');

  const { maxOpenStudentMics: limit } = await getSchoolSettings();
  if (limit <= 0) {
    return jsonOk({ granted: false, waiting: false, position: null, limited: false });
  }

  const book = await readMicBook(code);
  const next = studentSetMic(book, me.id, body.want, limit);
  await writeMicBook(code, next);

  const redis = await ensureRedis();
  const granted = next.granted && body.want;
  if (!body.want || !granted) {
    await prisma.participant.update({ where: { id: me.id }, data: { mutedByTeacher: true } });
    await redis.sadd(keys.muted(code), me.id);
    void setParticipantMicAllowed(code, me.livekitIdentity, false, false);
    pushMuteState(room.code, room.sessionId, [me.livekitIdentity], true);
  } else {
    await prisma.participant.update({ where: { id: me.id }, data: { mutedByTeacher: false } });
    await redis.srem(keys.muted(code), me.id);
    const { visible } = await getVisibleSample(code);
    void setParticipantMicAllowed(code, me.livekitIdentity, true, visible.includes(me.livekitIdentity));
    pushMuteState(room.code, room.sessionId, [me.livekitIdentity], false);
  }

  const promoted = 'promoted' in next ? (next as { promoted?: string | null }).promoted : null;
  if (promoted) {
    const nextStudent = await prisma.participant.findFirst({ where: { id: promoted, roomId: room.id } });
    if (nextStudent) {
      await prisma.participant.update({ where: { id: nextStudent.id }, data: { mutedByTeacher: false } });
      await redis.srem(keys.muted(code), nextStudent.id);
      const { visible } = await getVisibleSample(code);
      void setParticipantMicAllowed(code, nextStudent.livekitIdentity, true, visible.includes(nextStudent.livekitIdentity));
      pushMuteState(room.code, room.sessionId, [nextStudent.livekitIdentity], false);
    }
  }

  // The teacher's queue view, this student and anyone promoted; nobody else.
  nudgeRoomState(code, { participantIds: promoted ? [me.id, promoted] : [me.id] });
  return jsonOk({ granted, waiting: next.waiting, position: next.position, limited: true });
}
