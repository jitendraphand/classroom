import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { createScreenSidecarToken, getPublicLiveKitUrl, livekitRoomName } from '@/lib/livekit';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/**
 * Token for the Windows app's native screen-share sidecar (publishes the
 * share directly from the capture helper). Owner teacher only; screen share
 * sources only; no subscribe, no data. Unlike /token it never touches the
 * stage or presence state.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });
  const participant = await prisma.participant.findFirst({
    where: { roomId: room.id, role: 'TEACHER' },
    orderBy: { createdAt: 'asc' },
  });
  if (!participant || participant.status === 'LEFT') return jsonError('Join the class first', 409);
  const roomName = livekitRoomName(room.code, room.sessionId);
  const { token, identity } = await createScreenSidecarToken({
    roomName,
    teacherIdentity: participant.livekitIdentity,
    name: participant.displayName,
    participantId: participant.id,
  });
  return jsonOk({ token, identity, url: getPublicLiveKitUrl(req), roomName });
}
