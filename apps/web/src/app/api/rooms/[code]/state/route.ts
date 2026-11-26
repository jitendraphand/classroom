import { whiteboardOn } from '@/lib/whiteboardServer';
import { camWanted } from '@/lib/camOnDemand';
import { studentCamMap } from '@/lib/studentCamera';
import { studentCameraAllowed } from '@/lib/speakingRules';
import { prisma } from '@/lib/db';
import { endedSessionReason, getStudentSessionToken, resolveRoomAccess } from '@/lib/auth';
import { recentTakeovers, wasReplaced } from '@/lib/deviceTakeoverServer';
import { readClassEndedBy } from '@/lib/auditLog';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, ensureSampleFresh, getVisibleSample } from '@/lib/sample';
import { ensureRedis, keys } from '@/lib/redis';
import { audienceIncludes } from '@/lib/grades';
import { formatStudentAudienceOf, studentPlaceLabel } from '@/lib/audienceLabels';
import { loadAudienceLabels } from '@/lib/audienceLabelStore';
import { manualStudentJoinAllowed } from '@/lib/schoolConfig';
import { decodeFocus } from '@/lib/focusStatus';
import { currentHolders, drawRequests } from '@/lib/drawServer';
import { studentRosterPresence } from '@/lib/studentPresence';
import { selectTeacherVideos } from '@/lib/droppedVideos';
import { getSchoolSettings } from '@/lib/schoolSettings';
import { classCapacity } from '@/lib/capacity';
import { readMicBook, micQueueView } from '@/lib/micBook';
import { memo, roomVersion, stateCacheMs } from '@/lib/roomStateCache';
import { listActiveObservers } from '@/lib/adminObservers';
import { syncObserverCameras } from '@/lib/observerSync';
import { admitIfDirectEntry } from '@/lib/admission';
import { nudgeRoomState } from '@/lib/roomNudge';

function teacherGenderOf(g: string | null | undefined) {
  return g === 'male' || g === 'female' ? g : null;
}

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';

  const loadRoom = () => prisma.room.findUnique({
    where: { code },
    include: {
      teacher: { select: { id: true, name: true, gender: true } },
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
  // Students share one snapshot per room version for STATE_CACHE_MS (lib/roomStateCache).
  const cacheMs = stateCacheMs();
  const ver = cacheMs > 0 ? await roomVersion(code) : '0';
  let room = cacheMs > 0 ? await memo(`state-room:${code}:${ver}`, cacheMs, loadRoom) : await loadRoom();
  if (!room) return jsonError('Room not found', 404);

  // Always surface ENDED quickly so clients can kick to ended UI without auth edge-cases
  if (room.status === 'ENDED') {
    const endedBy = await readClassEndedBy(room.code, room.sessionId);
    return jsonOk({
      code: room.code,
      name: room.name,
      status: 'ENDED',
      ended: true,
      ...(endedBy ? { endedBy } : {}),
      teacherName: room.teacher.name,
      teacherGender: teacherGenderOf(room.teacher.gender),
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
  // The teacher always gets a fresh read (roster, waiting list, presence).
  if (isTeacher && cacheMs > 0) room = (await loadRoom()) ?? room;

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
      teacherGender: teacherGenderOf(room.teacher.gender),
      public: true,
      teacherSessionActive: !!access.teacher,
      teacherSessionName: access.teacher?.name ?? null,
      manualJoinAllowed: manualStudentJoinAllowed(),
      ...(replaced ? { replaced: true } : {}),
      ...(meLeft ? { meLeft: true, me: { status: 'LEFT', role: 'STUDENT', displayName: access.student!.displayName, viaSchoolApp: !!access.student!.studentId } } : {}),
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

    if (me?.status !== 'ADMITTED') {
      // Direct entry (waiting room off): let a still-waiting seat in now, e.g.
      // one that arrived during the toggle or while the class was full.
      let myStatus: string | undefined = me?.status;
      if (me && access.student && access.student.id === me.id && (await admitIfDirectEntry(room, access.student))) {
        myStatus = 'ADMITTED';
        nudgeRoomState(room.code, 'teacher');
      }
      const myHand = me ? (await redis.sismember(keys.hands(code), me.id)) === 1 : false;
      const settings = await getSchoolSettings();
      const cap = classCapacity(settings.maxStudentsPerClass);
      const admittedCount = room.participants.filter((p) => p.role === 'STUDENT' && p.status === 'ADMITTED').length;
      return jsonOk({
        code: room.code,
        name: room.name,
        status: room.status,
        teacherName: room.teacher.name,
        teacherGender: teacherGenderOf(room.teacher.gender),
        maxVisibleVideos: clampMaxVisible(room.maxVisibleVideos),
        isTeacher: false,
        actingAsStudent: forceStudent || (access.mode === 'student' && !!access.teacherOwns),
        teacherSessionActive: !!access.teacher,
        me: me
          ? {
              id: me.id,
              displayName: me.displayName,
              role: me.role,
              status: myStatus ?? me.status,
              viaSchoolApp: !!me.studentId,
              livekitIdentity: me.livekitIdentity,
              mutedByTeacher: false,
              canPublishVideo: false,
              inVisibleSample: false,
              handRaised: myHand,
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

  const redis = await ensureRedis();
  const loadShared = async () => {
  await ensureSampleFresh(code);
  // Independent reads, issued together (ioredis pipelines them on one socket).
  const [[{ visible }, mutedIds, handList, handTimes, stageRaw, focusRaw, drawHolders, drawReqs, desktopInkRaw, panelRaw], [settings, spotlightId, micBook, obsRes], whiteboard] = await Promise.all([Promise.all([
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
  ]), Promise.all([
    getSchoolSettings(),
    redis.get(keys.spotlight(code)),
    readMicBook(code),
    listActiveObservers(code).catch(() => ({ observers: [] as string[], transitionedToInactive: false })),
  ]), whiteboardOn(code)]);
  if (obsRes.transitionedToInactive) void syncObserverCameras(code, false);
  return { visible, mutedIds, handList, handTimes, stageRaw, focusRaw, drawHolders, drawReqs, desktopInkRaw, panelRaw, settings, spotlightId, micBook, whiteboard, activeObservers: obsRes.observers };
  };
  // Students: one computation per room version per worker, shared by every request.
  const { visible, mutedIds, handList, handTimes, stageRaw, focusRaw, drawHolders, drawReqs, desktopInkRaw, panelRaw, settings, spotlightId, micBook, whiteboard, activeObservers } =
    isTeacher ? await loadShared() : await memo(`state-shared:${code}:${ver}`, cacheMs, loadShared);
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
    teacher?: { name: string; gender: string | null };
  } | null = null;
  const lateByStudent = new Map<string, boolean>();
  if (room.classSessionId) {
    const csId = room.classSessionId;
    const loadCs = () =>
      prisma.classSession.findUnique({
        where: { id: csId },
        select: {
          id: true,
          campus: true,
          campuses: true,
          grade: true,
          divisions: true,
          allDivisions: true,
          subject: true,
          adHoc: true,
          academicYear: true,
          scheduledStart: true,
          scheduledEnd: true,
          teacher: { select: { name: true, gender: true } },
        },
      });
    // These fields do not change during a class: students share them for 30 s.
    classSession = await memo(`state-cs:${csId}`, cacheMs > 0 ? 30_000 : 0, loadCs);
    if (classSession && isTeacher) {
      const cid = classSession.id;
      const recs = await prisma.attendanceRecord.findMany({
        where: { classSessionId: cid },
        select: { studentId: true, late: true },
      });
      for (const r of recs) lateByStudent.set(r.studentId, r.late);
    }
  }
  const audienceLabels = await loadAudienceLabels().catch(() => undefined);
  const classInfo = classSession
    ? {
        subject: classSession.subject,
        teacherName: classSession.teacher?.name || room.teacher.name,
        teacherGender: teacherGenderOf(classSession.teacher?.gender || room.teacher.gender),
        audience: formatStudentAudienceOf(classSession, audienceLabels),
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
      gradeDivision: st ? studentPlaceLabel(st, audienceLabels) : null,
      late: p.studentId ? lateByStudent.get(p.studentId) ?? false : false,
      onTimetable: !!st && !!classSession && audienceIncludes(classSession, st),
      viaSchoolApp: !!p.studentId,
      adHocClass: !!classSession?.adHoc,
    };
  };
  // Explicit leave drops off after a short grace. A late heartbeat stays
  // listed as reconnecting (lib/studentPresence) so the count matches who is
  // still in the room.
  const camMap = isTeacher ? await studentCamMap(code).catch(() => new Map<string, boolean>()) : new Map<string, boolean>();
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

  // A teacher-unmuted student may publish camera outside the sample (teacher's
  // speaking pop-up), and an active admin observer lets all camera-on students
  // publish low-layer video without flooding the teacher.
  const observerActive = activeObservers.length > 0;
  const meUnmuted = !!me && me.role === 'STUDENT' && !me.mutedByTeacher && !mutedIds.includes(me.id);
  const meSpotlighted = !!me && !!spotlight && spotlight.participantId === me.id;
  const camForTeacher =
    isTeacher || (me ? studentCameraAllowed({ inSample: visible.includes(me.livekitIdentity), spotlighted: meSpotlighted, unmuted: meUnmuted }) : false);
  const canPublishVideo =
    isTeacher || (me ? studentCameraAllowed({ inSample: visible.includes(me.livekitIdentity), spotlighted: meSpotlighted, unmuted: meUnmuted, observerActive }) : false);

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
        camForTeacher,
        inVisibleSample: canPublishVideo,
        /** Publish camera video now (in the sample AND the teacher shows the video panel, spotlighted, or observed). */
        camWanted: camWanted({
          isTeacher,
          inSample: canPublishVideo,
          panelRaw,
          spotlighted: meSpotlighted || meUnmuted,
          observerActive,
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

  const admittedView = (list: typeof admitted) => list.map((p) => ({
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
            studentId: p.studentId,
            /** Camera on (student's report): the teacher may only unmute these. */
            camOn: camMap.get(p.livekitIdentity) === true,
          }
        : {}),
      drawing: p.role === 'STUDENT' && drawingIds.has(p.id),
      micWaiting: p.role === 'STUDENT' && settings.maxOpenStudentMics > 0 && micBook.queue.some((w) => w.id === p.id),
      ...rosterInfo(p),
      ...focusOf(p),
    }));
  // Students do not get the class roster: their view needs the teacher(s),
  // the students whose video or ink is on screen (sample, spotlight, drawing)
  // and themselves. Sending all ~2,000 rows to every student was ~400 KB of
  // JSON per poll. The shared part is computed once per room version.
  let admittedOut: ReturnType<typeof admittedView>;
  if (isTeacher) {
    admittedOut = admittedView(admitted);
  } else {
    const visibleSet = new Set(visible);
    const shared = await memo(`state-adm:${code}:${ver}`, cacheMs, async () =>
      admittedView(
        admitted.filter(
          (p) =>
            p.role === 'TEACHER' ||
            visibleSet.has(p.livekitIdentity) ||
            p.id === spotlight?.participantId ||
            drawingIds.has(p.id)
        )
      )
    );
    const mine = me && me.status === 'ADMITTED' && !shared.some((p) => p.id === me.id) ? admittedView([me]) : [];
    admittedOut = mine.length ? [...shared, ...mine] : shared;
  }
  const admittedStudentCount = admitted.filter((p) => p.role === 'STUDENT').length;

  return jsonOk({
    code: room.code,
    // Readable title (Nov 25): "Physics · Airport Campus · Grade 7 · …", not the stored codes.
    name: classInfo ? [classInfo.subject, classInfo.audience].filter(Boolean).join(' · ') || room.name : room.name,
    status: room.status,
    maxVisibleVideos: clampMaxVisible(room.maxVisibleVideos),
    waitingRoomOn: room.waitingRoomOn,
    teacherName: room.teacher.name,
    teacherGender: teacherGenderOf(room.teacher.gender),
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
          audience: classInfo?.audience || '',
          adHoc: classSession.adHoc,
        }
      : null,
    classInfo,
    admitted: admittedOut,
    /** Students in the class (students get a trimmed `admitted` list). */
    admittedStudentCount,
    visibleIdentities: visibleForView,
    visibleCount: visibleForView.length,
    raisedHands,
    stageMode,
    /** The share already shows student ink (drawn on the teacher's desktop): skip the stroke overlay. */
    desktopInk: stageMode === 'screen' && desktopInkRaw === '1',
    whiteboard,
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
    observerIdentities: !isTeacher && activeObservers.length ? activeObservers : undefined,
  });
}
