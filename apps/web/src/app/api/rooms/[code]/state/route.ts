import { camWanted } from '@/lib/camOnDemand';
import { prisma } from '@/lib/db';
import { endedSessionReason, resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, ensureSampleFresh, getVisibleSample } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';
import { audienceIncludes, formatAudience } from '@/lib/grades';
import { manualStudentJoinAllowed } from '@/lib/schoolConfig';
import { decodeFocus } from '@/lib/focusStatus';
import { currentHolder, drawRequests } from '@/lib/drawServer';

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
          pinnedAt: true,
          createdAt: true,
          studentId: true,
          student: { select: { rollNumber: true, campus: true, grade: true, division: true, externalId: true } },
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
  const redis = await ensureRedis();
  // Independent reads, issued together (ioredis pipelines them on one socket).
  const [{ visible }, mutedIds, handList, handTimes, stageRaw, focusRaw, drawHolder, drawReqs, desktopInkRaw, panelRaw] = await Promise.all([
    getVisibleSample(code),
    redis.smembers(keys.muted(code)),
    redis.smembers(keys.hands(code)),
    isTeacher ? redis.hgetall(keys.handsAt(code)) : Promise.resolve({} as Record<string, string>),
    redis.get(keys.stage(code)),
    // Students' fullscreen / focus status, teacher only.
    isTeacher ? redis.hgetall(keys.focus(code)) : Promise.resolve({} as Record<string, string>),
    currentHolder(code, redis),
    drawRequests(code, redis),
    redis.get(keys.desktopInk(code)),
    redis.get(keys.videoPanel(code)),
  ]);
  const drawReqAt = new Map(drawReqs.map((d) => [d.id, d.at]));
  const handSet = handList.map(String);
  const handAt = (id: string) => (handTimes[id] ? Number(handTimes[id]) : null);
  // Earliest raise first (hands without a time, raised before it was recorded, last).
  const raisedHands = [...handSet].sort(
    (a, b) => (handAt(a) ?? Number.MAX_SAFE_INTEGER) - (handAt(b) ?? Number.MAX_SAFE_INTEGER)
  );
  const stageMode =
    stageRaw === 'screen' ? 'screen' : 'idle';
  const focusOf = (p: (typeof room.participants)[number]) => {
    if (!isTeacher || p.role !== 'STUDENT') return {};
    const f = decodeFocus(focusRaw[p.id]);
    return f ? { focus: f.focus, focusIphone: f.iphone } : {};
  };

  const waiting = room.participants.filter((p) => p.status === 'WAITING' && p.role === 'STUDENT');

  // Roster details for the teacher: roll number, grade-division, late flag and
  // whether the student belongs to this class's timetabled audience.
  let classSession: { id: string; campus: string; grade: string; divisions: string[]; allDivisions: boolean; subject: string; adHoc: boolean } | null = null;
  const lateByStudent = new Map<string, boolean>();
  if (isTeacher && room.classSessionId) {
    classSession = await prisma.classSession.findUnique({
      where: { id: room.classSessionId },
      select: { id: true, campus: true, grade: true, divisions: true, allDivisions: true, subject: true, adHoc: true },
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
      sid: st?.externalId ?? null,
      gradeDivision: st ? `${st.campus} · ${st.grade}-${st.division}` : null,
      late: p.studentId ? lateByStudent.get(p.studentId) ?? false : false,
      onTimetable: !!st && !!classSession && audienceIncludes(classSession, st),
      viaSchoolApp: !!p.studentId,
      adHocClass: !!classSession?.adHoc,
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
        viaSchoolApp: !!me.studentId,
        livekitIdentity: me.livekitIdentity,
        mutedByTeacher: me.mutedByTeacher || mutedIds.includes(me.id),
        canPublishVideo,
        inVisibleSample: canPublishVideo,
        /** Publish camera video now (in the sample AND the teacher shows the video panel). */
        camWanted: camWanted({ isTeacher, inSample: canPublishVideo, panelRaw }),
        handRaised: raisedHands.includes(me.id),
        drawRequested: drawReqAt.has(me.id),
        canDraw: drawHolder?.participantId === me.id,
      }
    : null;

  return jsonOk({
    code: room.code,
    name: room.name,
    status: room.status,
    maxVisibleVideos: clampMaxVisible(room.maxVisibleVideos),
    waitingRoomOn: room.waitingRoomOn,
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
          audience: formatAudience(classSession.campus, classSession.grade, classSession.divisions, classSession.allDivisions),
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
      ...(isTeacher && p.role === 'STUDENT'
        ? {
            handRaisedAt: raisedHands.includes(p.id) ? handAt(p.id) : null,
            pinned: !!p.pinnedAt,
            pinnedAt: p.pinnedAt ? p.pinnedAt.getTime() : null,
            drawRequested: drawReqAt.has(p.id),
            drawRequestedAt: drawReqAt.get(p.id) ?? null,
          }
        : {}),
      drawing: p.role === 'STUDENT' && drawHolder?.participantId === p.id,
      ...rosterInfo(p),
      ...focusOf(p),
    })),
    visibleIdentities: visible,
    visibleCount: visible.length,
    raisedHands,
    stageMode,
    /** The share already shows student ink (drawn on the teacher's desktop): skip the stroke overlay. */
    desktopInk: stageMode === 'screen' && desktopInkRaw === '1',
    videoPanelOpen: panelRaw !== '0',
    /** Student allowed to draw on the share now (one at a time), for everyone. */
    drawHolder: drawHolder
      ? { participantId: drawHolder.participantId, identity: drawHolder.identity, name: drawHolder.name, until: drawHolder.until }
      : null,
    drawRequestCount: isTeacher ? drawReqs.length : undefined,
    sampleNote:
      'Only a rotating sample of students publish video to the teacher. Everyone keeps a local preview and may appear visible.',
  });
}
