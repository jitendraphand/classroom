import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { createParticipantToken, getPublicLiveKitUrl, livekitRoomName } from '@/lib/livekit';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureSampleFresh } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
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
        })
      : access.mode === 'student' && access.student && access.student.roomId === room.id
        ? access.student
        : null;

  if (!participant) return jsonError('Unauthorized', 401);
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

  const token = await createParticipantToken({
    roomName: livekitRoomName(code),
    identity: participant.livekitIdentity,
    name: participant.displayName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    mutedByTeacher,
    metadata: {
      role: participant.role,
      participantId: participant.id,
      canPublishVideo,
      mutedByTeacher,
    },
  });

  return jsonOk({
    token,
    url: getPublicLiveKitUrl(req),
    roomName: livekitRoomName(code),
    identity: participant.livekitIdentity,
    canPublishVideo,
    visibleIdentities: sample.visible,
    mutedByTeacher,
  });
}
