import { prisma } from '@/lib/db';
import { getStudentParticipant, clearStudentCookie, getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { rotateVisibleSample, unpinSpeaker } from '@/lib/sample';
import { livekitRoomName, removeLiveKitParticipant } from '@/lib/livekit';
import { z } from 'zod';

const schema = z.object({
  participantId: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);

  let participantId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    participantId = schema.parse(body).participantId;
  } catch {
    /* empty */
  }

  const teacher = await getTeacherSession();
  const self = await getStudentParticipant();
  const isRoomTeacher = !!teacher && room.teacherId === teacher.id;

  let target = self;

  if (participantId) {
    // Teacher-issued removal. Scoped to STUDENT so a teacher cannot mark the
    // teacher participant (or any non-student) LEFT via this endpoint.
    if (!isRoomTeacher) return jsonError('Not in room', 403);
    target = await prisma.participant.findFirst({
      where: { id: participantId, roomId: room.id, role: 'STUDENT' },
      include: { room: true },
    });
    if (!target) return jsonError('Participant not found', 404);
  } else if (!self && isRoomTeacher) {
    // Teacher leaving their own class. Previously this resolved to `null` (a
    // teacher has no student session cookie) and returned 403, so the teacher
    // appeared to leave while their participant row stayed ADMITTED.
    target = await prisma.participant.findFirst({
      where: { roomId: room.id, role: 'TEACHER' },
      include: { room: true },
    });
  }

  if (!target || target.roomId !== room.id) return jsonError('Not in room', 403);

  await prisma.participant.update({
    where: { id: target.id },
    data: { status: 'LEFT', leftAt: new Date() },
  });

  const redis = await ensureRedis();
  await redis.srem(keys.waiting(code), target.id);
  await redis.srem(keys.admitted(code), target.id);
  await redis.srem(keys.muted(code), target.id);
  await redis.srem(keys.hands(code), target.id);
  await redis.srem(keys.visible(code), target.livekitIdentity);

  if (self && self.id === target.id) await clearStudentCookie();

  // Cut the media connection too. For a teacher-removed student this is what
  // actually stops them receiving the class; the LEFT status above revokes their
  // admission so /token will not mint them a new LiveKit token.
  if (target.role === 'STUDENT') {
    await removeLiveKitParticipant(livekitRoomName(room.code, room.sessionId), target.livekitIdentity);
  }

  if (target.role === 'STUDENT') {
    // Frees the departing student's sticky speak-pin along with their slot.
    await unpinSpeaker(code, target.livekitIdentity);
    await rotateVisibleSample(code);
  }

  return jsonOk({ ok: true });
}
