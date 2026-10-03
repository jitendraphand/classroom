import { prisma } from '@/lib/db';
import { endedSessionReason, resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, ensureSampleFresh, getVisibleSample } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';
import { audienceIncludes, formatAudience } from '@/lib/grades';
import { manualStudentJoinAllowed } from '@/lib/schoolConfig';
import { decodeFocus } from '@/lib/focusStatus';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
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
          studentId: true,
          student: { select: { rollNumber: true, grade: true, division: true } },
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
      maxVisibleVideos: clampMaxVisible(room.maxVisibleVideos),
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
    // A teacher/admin whose session was replaced or revoked (e.g. the class tab
    // left open on the old device): say why instead of the public join info.
    const reason = await endedSessionReason();
    if (reason) return jsonError('Your session has ended', 401, { reason });
    // Public minimal info for join page — include teacher-session hint
    return jsonOk({
      code: room.code,
      name: room.name,
      status: room.status,
      teacherName: room.teacher.name,
      public: true,
      teacherSessionActive: !!access.teacher,
      teacherSessionName: access.teacher?.name ?? null,
      manualJoinAllowed: manualStudentJoinAllowed(),
    });
  }

  // A student in the waiting lobby knows only that they exist and which class
  // they queued for. Returning the admitted roster, LiveKit identities and the
  // visible sample leaked the whole class to anyone who had the room code before
  // being admitted, and made the lobby page re-download it every 2s. Bail out
  // before the sample/Redis reads, which this client does not need.
  if (!isTeacher) {
    const me = room.participants.find((p) => p.id === access.student?.id);
    const redis = await ensureRedis();
    const stageRaw = await redis.get(keys.stage(code));
    const stageMode =
      stageRaw === 'screen' ? 'screen' : 'idle';
    const raisedHands = (await redis.smembers(keys.hands(code))).map(String);

    if (me?.status !== 'ADMITTED') {
      return jsonOk({
        code: room.code,
        name: room.name,
        status: room.status,
        teacherName: room.teacher.name,
        maxVisibleVideos: clampMaxVisible(room.maxVisibleVideos),
        isTeacher: false,
        actingAsStudent: forceStudent || (access.mode === 'student' && !!access.teacherOwns),
        teacherSessionActive: !!access.teacher,
        me: me
          ? {
              id: me.id,
              displayName: me.displayName,
              role: me.role,
              status: me.status,
              viaSchoolApp: !!me.studentId,
              livekitIdentity: me.livekitIdentity,
              mutedByTeacher: false,
              canPublishVideo: false,
              inVisibleSample: false,
              handRaised: raisedHands.includes(me.id),
            }
          : null,
        admitted: [],
        visibleIdentities: [],
        visibleCount: 0,
        raisedHands: [],
        stageMode,
      });
    }
  }

  await ensureSampleFresh(code);
  const { visible } = await getVisibleSample(code);
  const redis = await ensureRedis();
  const mutedIds = await redis.smembers(keys.muted(code));
  const raisedHands = (await redis.smembers(keys.hands(code))).map(String);
  const stageRaw = await redis.get(keys.stage(code));
  const stageMode =
    stageRaw === 'screen' ? 'screen' : 'idle';
  // Students' fullscreen / focus status, teacher only.
  const focusRaw: Record<string, string> = isTeacher ? await redis.hgetall(keys.focus(code)) : {};
  const focusOf = (p: (typeof room.participants)[number]) => {
    if (!isTeacher || p.role !== 'STUDENT') return {};
    const f = decodeFocus(focusRaw[p.id]);
    return f ? { focus: f.focus, focusIphone: f.iphone } : {};
  };

  const waiting = room.participants.filter((p) => p.status === 'WAITING' && p.role === 'STUDENT');

  // Roster details for the teacher: roll number, grade-division, late flag and
  // whether the student belongs to this class's timetabled audience.
  let classSession: { id: string; grade: string; divisions: string[]; allDivisions: boolean; subject: string; adHoc: boolean } | null = null;
  const lateByStudent = new Map<string, boolean>();
  if (isTeacher && room.classSessionId) {
    classSession = await prisma.classSession.findUnique({
      where: { id: room.classSessionId },
      select: { id: true, grade: true, divisions: true, allDivisions: true, subject: true, adHoc: true },
    });
    if (classSession) {
      const recs = await prisma.attendanceRecord.findMany({
        where: { classSessionId: classSession.id },
        select: { studentId: true, late: true },
      });
      for (const r of recs) lateByStudent.set(r.studentId, r.late);
    }
  }
  const rosterInfo = (p: (typeof room.participants)[number]) => {
    if (!isTeacher || p.role !== 'STUDENT') return {};
    const st = p.student;
    return {
      rollNumber: st?.rollNumber ?? null,
      gradeDivision: st ? `${st.grade}-${st.division}` : null,
      late: p.studentId ? lateByStudent.get(p.studentId) ?? false : false,
      onTimetable: !!st && !!classSession && audienceIncludes(classSession, st.grade, st.division),
      viaSchoolApp: !!p.studentId,
    };
  };
  const admitted = room.participants.filter((p) => p.status === 'ADMITTED');

  const me = isTeacher
    ? room.participants.find((p) => p.role === 'TEACHER')
    : access.student
      ? room.participants.find((p) => p.id === access.student!.id)
      : null;

  const canPublishVideo =
    isTeacher || (me ? visible.includes(me.livekitIdentity) : false);

  const mePayload = me
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
    : null;

  return jsonOk({
    code: room.code,
    name: room.name,
    status: room.status,
    maxVisibleVideos: clampMaxVisible(room.maxVisibleVideos),
    teacherName: room.teacher.name,
    isTeacher,
    actingAsStudent: forceStudent || (access.mode === 'student' && !!access.teacherOwns),
    teacherSessionActive: !!access.teacher,
    me: mePayload,
    waiting: isTeacher
      ? waiting.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          createdAt: p.createdAt,
          ...rosterInfo(p),
        }))
      : undefined,
    classSession: classSession
      ? {
          subject: classSession.subject,
          audience: formatAudience(classSession.grade, classSession.divisions, classSession.allDivisions),
          adHoc: classSession.adHoc,
        }
      : null,
    admitted: admitted.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      role: p.role,
      livekitIdentity: p.livekitIdentity,
      mutedByTeacher: p.mutedByTeacher || mutedIds.includes(p.id),
      isVisible: p.role === 'TEACHER' || visible.includes(p.livekitIdentity),
      handRaised: p.role === 'STUDENT' && raisedHands.includes(p.id),
      ...rosterInfo(p),
      ...focusOf(p),
    })),
    visibleIdentities: visible,
    visibleCount: visible.length,
    raisedHands,
    stageMode,
    sampleNote:
      'Only a rotating sample of students publish video to the teacher. Everyone keeps a local preview and may appear visible.',
  });
}
