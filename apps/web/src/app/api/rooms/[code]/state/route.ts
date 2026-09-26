import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureSampleFresh, getVisibleSample } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';

  const room = await prisma.room.findUnique({
    where: { code },
    include: {
      teacher: { select: { id: true, name: true } },
      participants: {
        where: { status: { in: ['WAITING', 'ADMITTED'] } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          displayName: true,
          role: true,
          status: true,
          livekitIdentity: true,
          mutedByTeacher: true,
          createdAt: true,
        },
      },
    },
  });
  if (!room) return jsonError('Room not found', 404);

  // Always surface ENDED quickly so clients can kick to ended UI without auth edge-cases
  if (room.status === 'ENDED') {
    return jsonOk({
      code: room.code,
      name: room.name,
      status: 'ENDED',
      ended: true,
      teacherName: room.teacher.name,
      public: true,
      maxVisibleVideos: room.maxVisibleVideos,
      isTeacher: false,
      me: null,
      admitted: [],
      visibleIdentities: [],
      visibleCount: 0,
    });
  }

  const access = await resolveRoomAccess(room, { forceStudent });
  const isTeacher = access.isTeacher;
  const isStudent = access.mode === 'student';

  if (!isTeacher && !isStudent) {
    // Public minimal info for join page — include teacher-session hint
    return jsonOk({
      code: room.code,
      name: room.name,
      status: room.status,
      teacherName: room.teacher.name,
      public: true,
      teacherSessionActive: !!access.teacher,
      teacherSessionName: access.teacher?.name ?? null,
    });
  }

  await ensureSampleFresh(code);
  const { visible } = await getVisibleSample(code);
  const redis = await ensureRedis();
  const mutedIds = await redis.smembers(keys.muted(code));
  const raisedHands = (await redis.smembers(keys.hands(code))).map(String);
  const stageRaw = await redis.get(keys.stage(code));
  const stageMode =
    stageRaw === 'screen' || stageRaw === 'whiteboard' || stageRaw === 'idle'
      ? stageRaw
      : 'idle';
  const wbWriteAllowed = (await redis.get(keys.wbWrite(code))) === '1';
  const whiteboardCanWrite = isTeacher || wbWriteAllowed;

  const waiting = room.participants.filter((p) => p.status === 'WAITING' && p.role === 'STUDENT');
  const admitted = room.participants.filter((p) => p.status === 'ADMITTED');

  const me = isTeacher
    ? room.participants.find((p) => p.role === 'TEACHER')
    : access.student
      ? room.participants.find((p) => p.id === access.student!.id)
      : null;

  const canPublishVideo =
    isTeacher || (me ? visible.includes(me.livekitIdentity) : false);

  return jsonOk({
    code: room.code,
    name: room.name,
    status: room.status,
    maxVisibleVideos: room.maxVisibleVideos,
    teacherName: room.teacher.name,
    isTeacher,
    actingAsStudent: forceStudent || (access.mode === 'student' && !!access.teacherOwns),
    teacherSessionActive: !!access.teacher,
    me: me
      ? {
          id: me.id,
          displayName: me.displayName,
          role: me.role,
          status: me.status,
          livekitIdentity: me.livekitIdentity,
          mutedByTeacher: me.mutedByTeacher || mutedIds.includes(me.id),
          canPublishVideo,
          inVisibleSample: canPublishVideo,
          handRaised: raisedHands.includes(me.id),
        }
      : null,
    waiting: isTeacher
      ? waiting.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          createdAt: p.createdAt,
        }))
      : undefined,
    admitted: admitted.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      role: p.role,
      livekitIdentity: p.livekitIdentity,
      mutedByTeacher: p.mutedByTeacher || mutedIds.includes(p.id),
      isVisible: p.role === 'TEACHER' || visible.includes(p.livekitIdentity),
      handRaised: p.role === 'STUDENT' && raisedHands.includes(p.id),
    })),
    visibleIdentities: visible,
    visibleCount: visible.length,
    raisedHands,
    stageMode,
    whiteboardCanWrite,
    /** Raw Redis wb-write flag (students may draw when true). */
    whiteboardWriteAllowed: wbWriteAllowed,
    sampleNote:
      'Only a rotating sample of students publish video to the teacher. Everyone keeps a local preview and may appear visible.',
  });
}
