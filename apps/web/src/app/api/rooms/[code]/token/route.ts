import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { createParticipantToken, getPublicLiveKitUrl, livekitRoomName } from '@/lib/livekit';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureSampleFresh } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';
import { isTeacherPresent } from '@/lib/teacherPresence';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';

  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  const access = await resolveRoomAccess(room, { forceStudent });

  let participant =
    access.isTeacher
      ? await prisma.participant.findFirst({
          where: { roomId: room.id, role: 'TEACHER' },
          orderBy: { createdAt: 'asc' },
        })
      : access.mode === 'student' && access.student && access.student.roomId === room.id
        ? access.student
        : null;

  if (!participant) return jsonError('Unauthorized', 401);

  // The owning teacher pressed Leave earlier and is coming back from the lobby
  // (or Back button) while the class is still open: re-admit instead of 403.
  // Only the authenticated room owner reaches this branch (access.isTeacher).
  if (access.isTeacher && participant.role === 'TEACHER' && participant.status === 'LEFT') {
    participant = await prisma.participant.update({
      where: { id: participant.id },
      data: { status: 'ADMITTED', leftAt: null },
    });
  }
  if (participant.role === 'STUDENT' && participant.status === 'WAITING') {
    return jsonError('Still in waiting room', 403);
  }
  if (participant.status === 'LEFT') return jsonError('You have left the class', 403);

  const sample = await ensureSampleFresh(code);
  const isTeacher = participant.role === 'TEACHER';
  const canPublishVideo = isTeacher || sample.visible.includes(participant.livekitIdentity);

  const redis = await ensureRedis();
  const mutedIds = await redis.smembers(keys.muted(code));
  const mutedByTeacher =
    !isTeacher && (participant.mutedByTeacher || mutedIds.includes(participant.id));

  // Students joining while the teacher is not connected to the SFU get a token
  // without microphone publish; the LiveKit webhook grants it when the teacher
  // connects (and revokes it again when the teacher leaves).
  const teacherPresent = isTeacher ? true : await isTeacherPresent(code, room);
  if (isTeacher) {
    // The teacher is (re)connecting: drop any cached presence so a missed
    // webhook cannot keep the class locked. Checks until the webhook confirms
    // the join fall back to asking LiveKit directly.
    await redis.del(keys.teacherPresent(code)).catch(() => undefined);
  }
  const micLocked = !isTeacher && !teacherPresent;

  const roomName = livekitRoomName(room.code, room.sessionId);
  const token = await createParticipantToken({
    role: participant.role,
    roomName,
    identity: participant.livekitIdentity,
    name: participant.displayName,
    mutedByTeacher,
    micLocked,
    // Server-side enforcement of selective video: a student outside the visible
    // sample is granted every source EXCEPT camera, so their video cannot reach
    // the SFU regardless of what the client does.
    allowCamera: canPublishVideo,
    metadata: {
      role: participant.role,
      participantId: participant.id,
      canPublishVideo,
      mutedByTeacher,
      micLocked,
    },
  });

  return jsonOk({
    token,
    url: getPublicLiveKitUrl(req),
    roomName,
    identity: participant.livekitIdentity,
    canPublishVideo,
    visibleIdentities: sample.visible,
    mutedByTeacher,
    teacherPresent,
  });
}
