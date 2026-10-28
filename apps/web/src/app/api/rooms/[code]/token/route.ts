import { prisma } from '@/lib/db';
import { endedSessionReason, resolveRoomAccess } from '@/lib/auth';
import { createParticipantToken, livekitRoomName, mediaUrlForRoom } from '@/lib/livekit';
import { noteRoomLoad } from '@/lib/mediaServers';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureSampleFresh } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';
import { isTeacherPresent } from '@/lib/teacherPresence';
import { clearStage } from '@/lib/sessionKick';
import { nextConnectDelayMs } from '@/lib/joinPacing';
import { parseMediaProfile } from '@/lib/videoQuality';

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

  // A replaced/revoked teacher session gets no media token, so a stale or
  // reloaded tab on the old device can never kick the active device.
  if (!participant) return jsonError('Unauthorized', 401, { reason: await endedSessionReason() });

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

  const isTeacher = participant.role === 'TEACHER';
  const redis = await ensureRedis();
  // Run-4 join profiling: these three were sequential round trips (Redis,
  // Redis, Redis-or-LiveKit). They are independent, so run them together;
  // SISMEMBER instead of SMEMBERS keeps the muted lookup O(1) in big classes.
  // Students joining while the teacher is not connected to the SFU get a token
  // without microphone publish; the LiveKit webhook grants it when the teacher
  // connects (and revokes it again when the teacher leaves).
  const [sample, mutedFlag, teacherPresent, spotlightId] = await Promise.all([
    ensureSampleFresh(code),
    isTeacher ? Promise.resolve(0) : redis.sismember(keys.muted(code), participant.id),
    isTeacher ? Promise.resolve(true) : isTeacherPresent(code, room),
    isTeacher ? Promise.resolve(null) : redis.get(keys.spotlight(code)),
  ]);
  const inSample = isTeacher || sample.visible.includes(participant.livekitIdentity);
  const canPublishVideo = inSample;
  const allowCamera = inSample || (!isTeacher && spotlightId === participant.id);
  const mutedByTeacher = !isTeacher && (participant.mutedByTeacher || mutedFlag === 1);

  if (isTeacher) {
    // The teacher is (re)connecting: drop any cached presence so a missed
    // webhook cannot keep the class locked. Checks until the webhook confirms
    // the join fall back to asking LiveKit directly.
    await redis.del(keys.teacherPresent(code)).catch(() => undefined);
    // A teacher token means a fresh connection (page load / device switch):
    // nothing is being shared from it yet, so a stage left at "screen" by the
    // previous device or tab is stale. (A network blip resumes without a new token.)
    await clearStage(code);
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
    allowCamera,
    metadata: {
      role: participant.role,
      participantId: participant.id,
      canPublishVideo,
      mutedByTeacher,
      micLocked,
      ...(participant.studentId ? { studentId: participant.studentId } : {}),
    },
  });

  let roomSize = 0;
  if (!isTeacher) {
    roomSize = await redis.scard(keys.admitted(code)).catch(() => 0);
    // Multi-server load accounting (no-op with one media node).
    void noteRoomLoad(roomName, roomSize).catch(() => undefined);
  }

  // Join-wave pacing: students wait for a slot before connecting to LiveKit;
  // the window grows with the room (lib/joinPacingLogic joinSpreadForRoom).
  const connectDelayMs = isTeacher ? 0 : await nextConnectDelayMs(Date.now(), roomSize);

  return jsonOk({
    mediaProfile: parseMediaProfile(process.env.MEDIA_PROFILE),
    connectDelayMs,
    token,
    url: await mediaUrlForRoom(roomName, req),
    roomName,
    identity: participant.livekitIdentity,
    canPublishVideo,
    visibleIdentities: sample.visible,
    mutedByTeacher,
    teacherPresent,
  });
}
