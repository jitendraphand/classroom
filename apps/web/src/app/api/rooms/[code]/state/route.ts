import { whiteboardOn } from '@/lib/whiteboardServer';
import { camWanted } from '@/lib/camOnDemand';
import { prisma } from '@/lib/db';
import { endedSessionReason, getStudentSessionToken, resolveRoomAccess } from '@/lib/auth';
import { cachedRead } from '@/lib/dbCache';
import { recentTakeovers, wasReplaced } from '@/lib/deviceTakeoverServer';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, ensureSampleFresh, getVisibleSample } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';
import { audienceIncludes, formatAudience } from '@/lib/grades';
import { manualStudentJoinAllowed } from '@/lib/schoolConfig';
import { decodeFocus } from '@/lib/focusStatus';
import { currentHolders, drawRequests } from '@/lib/drawServer';
import { studentRosterPresence } from '@/lib/studentPresence';
import { selectTeacherVideos } from '@/lib/droppedVideos';
import { getSchoolSettings } from '@/lib/schoolSettings';
import { classCapacity } from '@/lib/capacity';
import { readMicBook, micQueueView } from '@/lib/micBook';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';

  const room = await cachedRead(`room-state:${code}`, () => prisma.room.findUnique({
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
  }));
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
    // Student tab whose seat moved to another device, or who left / was removed.
    const token = await getStudentSessionToken();
    const replaced = await wasReplaced(token);
    const meLeft = !replaced && !!access.student && access.student.roomId === room.id && access.student.status === 'LEFT';
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
      ...(replaced ? { replaced: true } : {}),
      ...(meLeft ? { meLeft: true } : {}),
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
      const settings = await getSchoolSettings();
      const cap = classCapacity(settings.maxStudentsPerClass);
      const admittedCount = room.participants.filter((p) => p.role === 'STUDENT' && p.status === 'ADMITTED').length;
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
        classFull: cap != null && admittedCount >= cap,
      });
    }
  }

  await ensureSampleFresh(code);
  const redis = await ensureRedis();
  // Independent reads, issued together (ioredis pipelines them on one socket).
  const [{ visible }, mutedIds, handList, handTimes, stageRaw, focusRaw, drawHolders, drawReqs, desktopInkRaw, panelRaw] = await Promise.all([
    getVisibleSample(code),
    redis.smembers(keys.muted(code)),
    redis.smembers(keys.hands(code)),
    isTeacher ? redis.hgetall(keys.handsAt(code)) : Promise.resolve({} as Record<string, string>),
    redis.get(keys.stage(code)),
    // Students' fullscreen / focus status, teacher only.
    isTeacher ? redis.hgetall(keys.focus(code)) : Promise.resolve({} as Record<string, string>),
    currentHolders(code, redis),
    drawRequests(code, redis),
    redis.get(keys.desktopInk(code)),
    redis.get(keys.videoPanel(code)),
  ]);
  const drawingIds = new Set(drawHolders.map((h) => h.participantId));
  // Back-compat single holder: a drawing student sees their own allow (timer).
  const drawHolder = drawHolders.find((h) => !isTeacher && h.participantId === access.student?.id) || drawHolders[0] || null;
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
  let classSession: {
    id: string;
    campus: string;
    grade: string;
    divisions: string[];
    allDivisions: boolean;
    subject: string;
    adHoc: boolean;
    academicYear: string;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
    teacher?: { name: string };
  } | null = null;
  const lateByStudent = new Map<string, boolean>();
  if (room.classSessionId) {
    const csId = room.classSessionId;
    classSession = await cachedRead(`class-session:v7:${csId}`, () =>
      prisma.classSession.findUnique({
        where: { id: csId },
        select: {
          id: true,
          campus: true,
          grade: true,
          divisions: true,
          allDivisions: true,
          subject: true,
          adHoc: true,
          academicYear: true,
          scheduledStart: true,
          scheduledEnd: true,
          teacher: { select: { name: true } },
        },
      })
    );
    if (classSession && isTeacher) {
      const cid = classSession.id;
      const recs = await cachedRead(`attendance-late:${cid}`, () =>
        prisma.attendanceRecord.findMany({
          where: { classSessionId: cid },
          select: { studentId: true, late: true },
        })
      );
      for (const r of recs) lateByStudent.set(r.studentId, r.late);
    }
  }
  const classInfo = classSession
    ? {
        subject: classSession.subject,
        teacherName: classSession.teacher?.name || room.teacher.name,
        audience: formatAudience(classSession.campus, classSession.grade, classSession.divisions, classSession.allDivisions),
        scheduledStart: classSession.scheduledStart ? classSession.scheduledStart.toISOString() : null,
        scheduledEnd: classSession.scheduledEnd ? classSession.scheduledEnd.toISOString() : null,
        classSessionId: classSession.id,
        academicYear: classSession.academicYear,
      }
    : null;
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
  // Explicit leave drops off after a short grace. A crash with no leave drops
  // off once the student heartbeat is stale (lib/studentPresence). Reconnecting
  // students stay listed with a flag.
  const presence = isTeacher
    ? await studentRosterPresence(code)
    : { gone: new Set<string>(), reconnecting: new Set<string>() };
  const gone = presence.gone;
  const admitted = room.participants.filter(
    (p) => p.status === 'ADMITTED' && !(p.role === 'STUDENT' && gone.has(p.livekitIdentity))
  );
  // Teacher video selection uses the same gone set as the roster. Publish
  // permission stays on the raw sample so a heartbeat that resumes puts the
  // tile back without waiting for the next rotation.
  const visibleForView = isTeacher ? selectTeacherVideos(visible, { dropped: gone, now: Date.now() }) : visible;

  const [settings, spotlightId, micBook] = await Promise.all([
    getSchoolSettings(),
    redis.get(keys.spotlight(code)),
    readMicBook(code),
  ]);
  const spotlightParticipant = spotlightId ? room.participants.find((p) => p.id === spotlightId && p.status === 'ADMITTED') : undefined;
  const spotlight = spotlightParticipant
    ? { participantId: spotlightParticipant.id, identity: spotlightParticipant.livekitIdentity, name: spotlightParticipant.displayName }
    : null;
  const names = new Map(room.participants.map((p) => [p.id, p.displayName]));
  const micQueue = isTeacher ? micQueueView(micBook, names) : [];
  const micOpen = new Set(micBook.open);

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
        /** Publish camera video now (in the sample AND the teacher shows the video panel, or spotlighted). */
        camWanted: camWanted({
          isTeacher,
          inSample: canPublishVideo,
          panelRaw,
          spotlighted: !!spotlight && spotlight.participantId === me.id,
        }),
        handRaised: raisedHands.includes(me.id),
        drawRequested: drawReqAt.has(me.id),
        canDraw: drawingIds.has(me.id),
        spotlighted: !!spotlight && spotlight.participantId === me.id,
        micGranted: settings.maxOpenStudentMics <= 0 ? !me.mutedByTeacher : micOpen.has(me.id),
        micWaiting: settings.maxOpenStudentMics > 0 && micBook.queue.some((w) => w.id === me.id),
        micPosition: settings.maxOpenStudentMics > 0 ? (micQueueView(micBook, names).find((w) => w.id === me.id)?.position ?? null) : null,
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
    classInfo,
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
            reconnecting: presence.reconnecting.has(p.livekitIdentity),
          }
        : {}),
      drawing: p.role === 'STUDENT' && drawingIds.has(p.id),
      micWaiting: p.role === 'STUDENT' && settings.maxOpenStudentMics > 0 && micBook.queue.some((w) => w.id === p.id),
      ...rosterInfo(p),
      ...focusOf(p),
    })),
    visibleIdentities: visibleForView,
    visibleCount: visibleForView.length,
    raisedHands,
    stageMode,
    /** The share already shows student ink (drawn on the teacher's desktop): skip the stroke overlay. */
    desktopInk: stageMode === 'screen' && desktopInkRaw === '1',
    whiteboard: await whiteboardOn(code),
    videoPanelOpen: panelRaw !== '0',
    /** Student allowed to draw on the share now (back-compat: first one, or me), for everyone. */
    drawHolder: drawHolder
      ? { participantId: drawHolder.participantId, identity: drawHolder.identity, name: drawHolder.name, until: drawHolder.until }
      : null,
    /** Every student drawing now (several at once). */
    drawHolders: drawHolders.map((h) => ({ participantId: h.participantId, identity: h.identity, name: h.name, until: h.until })),
    drawRequestCount: isTeacher ? drawReqs.length : undefined,
    /** Teacher: students whose newer device took over their seat (toast). */
    takeovers: isTeacher ? await recentTakeovers(code) : undefined,
    sampleNote:
      'Only a rotating sample of students publish video to the teacher. Everyone keeps a local preview and may appear visible.',
    classFull: false,
    spotlight,
    micLimit: settings.maxOpenStudentMics,
    micQueue: isTeacher ? micQueue : undefined,
  });
}
