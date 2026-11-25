import type { ClassSession, Room } from '@prisma/client';
import { naturalCompare } from './naturalSort';
import { prisma } from './db';
import { audienceCampuses } from './grades';
import { formatStudentAudienceOf, studentPlaceLabel, type AudienceLabels } from './audienceLabels';
import { loadAudienceLabels } from './audienceLabelStore';
import { formatTeacherName } from './teacherSalutation';
import { studentCamMap } from './studentCamera';
import { livekitRoomName } from './livekit';
import { listRoomParticipants } from './teacherPresence';
import { isOngoingClass, summarizeRoomParticipants, type LiveClass } from './liveClassesLogic';

/**
 * Ongoing classes for the admin view.
 *
 * Counts come from the SFU (LiveKit listParticipants), the same source the
 * attendance webhook is fed from (`student_…` identities only), so a tile
 * agrees with who is actually connected right now. If LiveKit cannot be
 * reached, the open attendance intervals (AttendanceRecord.connectedSince set
 * by that webhook) are used instead and `countSource` says so.
 */

type RoomWithTeacher = Room & { teacher: { name: string; gender: string | null } };

export type LiveRosterStudent = {
  id: string;
  identity: string;
  name: string;
  gradeDivision: string;
  rollNumber: string | null;
  camOn: boolean;
};

async function ongoingPairs(code?: string): Promise<{ room: RoomWithTeacher; cs: ClassSession }[]> {
  const rooms = await prisma.room.findMany({
    where: { status: { not: 'ENDED' }, classSessionId: { not: null }, ...(code ? { code } : {}) },
    include: { teacher: { select: { name: true, gender: true } } },
  });
  if (!rooms.length) return [];
  const sessions = await prisma.classSession.findMany({
    where: { id: { in: rooms.map((r) => r.classSessionId!) } },
  });
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return rooms
    .map((room) => ({ room, cs: byId.get(room.classSessionId!) }))
    .filter((x): x is { room: RoomWithTeacher; cs: ClassSession } => !!x.cs && isOngoingClass(x.room, x.cs));
}

async function presence(room: Room, cs: ClassSession) {
  try {
    const live = await listRoomParticipants({ code: room.code, sessionId: room.sessionId });
    const identities = live.map((p) => p.identity).filter((id) => id.startsWith('student_'));
    const rows = identities.length
      ? await prisma.participant.findMany({
          where: { roomId: room.id, livekitIdentity: { in: identities } },
          select: { livekitIdentity: true, studentId: true },
        })
      : [];
    const studentIdByIdentity = new Map(rows.map((r) => [r.livekitIdentity, r.studentId]));
    // DB studentId covers a second device whose token was issued before
    // metadata carried studentId. Distinct key is the same one the roster uses.
    const s = summarizeRoomParticipants(
      live.map((p) => ({
        identity: p.identity,
        metadata: p.metadata,
        studentId: studentIdByIdentity.get(p.identity) ?? null,
      }))
    );
    return { ...s, countSource: 'livekit' as const };
  } catch (e) {
    console.warn('live classes: LiveKit unavailable, using attendance', room.code, e instanceof Error ? e.message : e);
    const open = await prisma.attendanceRecord.findMany({
      where: { classSessionId: cs.id, connectedSince: { not: null } },
      select: { studentId: true },
    });
    const ids = [...new Set(open.map((r) => r.studentId).filter((id): id is string => !!id))];
    return {
      studentIdentities: null as string[] | null,
      openStudentIds: ids,
      studentCount: ids.length,
      teacherConnected: null,
      countSource: 'attendance' as const,
    };
  }
}

function toLiveClass(
  room: RoomWithTeacher,
  cs: ClassSession,
  p: Awaited<ReturnType<typeof presence>>,
  labels?: AudienceLabels
): LiveClass {
  const audience = formatStudentAudienceOf(cs, labels);
  const title = [cs.subject, audience].filter(Boolean).join(' · ') || room.name;
  return {
    code: room.code,
    sessionId: room.sessionId,
    classSessionId: cs.id,
    title,
    subject: cs.subject,
    gradeDivision: audience,
    campus: cs.campus,
    campuses: audienceCampuses(cs),
    teacherName: formatTeacherName(room.teacher.name, room.teacher.gender),
    startedAt: cs.startedAt!.toISOString(),
    studentCount: p.studentCount,
    teacherConnected: p.teacherConnected,
    countSource: p.countSource,
  };
}

/**
 * Short shared cache (run 4: the admin page took 9.4 s with many classes,
 * because every admin poll asked LiveKit once per class). Every admin tab and
 * poll within LIVE_LIST_CACHE_MS shares one computation.
 */
const LIVE_LIST_CACHE_MS = 4_000;
let liveListCache: { at: number; p: Promise<LiveClass[]> } | null = null;

export async function listLiveClasses(): Promise<LiveClass[]> {
  const hit = liveListCache;
  if (hit && Date.now() - hit.at < LIVE_LIST_CACHE_MS) return hit.p;
  const p = computeLiveClasses();
  liveListCache = { at: Date.now(), p };
  p.catch(() => {
    if (liveListCache?.p === p) liveListCache = null;
  });
  return p;
}

async function computeLiveClasses(): Promise<LiveClass[]> {
  const pairs = await ongoingPairs();
  const labels = pairs.length ? await loadAudienceLabels().catch(() => undefined) : undefined;
  const out = await Promise.all(
    pairs.map(async ({ room, cs }) => toLiveClass(room, cs, await presence(room, cs), labels))
  );
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** One ongoing class plus the students currently connected (with camera status). */
export async function getLiveClass(
  code: string
): Promise<{ liveClass: LiveClass; roomName: string; students: LiveRosterStudent[] } | null> {
  const [pair] = await ongoingPairs(code);
  if (!pair) return null;
  const { room, cs } = pair;
  const [p, labels, camMap] = await Promise.all([
    presence(room, cs),
    loadAudienceLabels().catch(() => undefined),
    studentCamMap(room.code).catch(() => new Map<string, boolean>()),
  ]);

  let students: LiveRosterStudent[] = [];
  if (p.studentIdentities) {
    const identities = p.studentIdentities;
    const rows = identities.length
      ? await prisma.participant.findMany({
          where: { roomId: room.id, livekitIdentity: { in: identities } },
          select: {
            livekitIdentity: true,
            displayName: true,
            studentId: true,
            student: { select: { id: true, name: true, campus: true, grade: true, division: true, rollNumber: true } },
          },
        })
      : [];
    const byIdentity = new Map(rows.map((r) => [r.livekitIdentity, r]));
    const seen = new Set<string>();
    for (const identity of identities) {
      const row = byIdentity.get(identity);
      const key = row?.studentId || identity;
      if (seen.has(key)) continue;
      seen.add(key);
      const camOn = camMap.get(identity) === true;
      const st = row?.student;
      if (st) {
        students.push({
          id: st.id,
          identity,
          name: st.name.trim() || row?.displayName?.trim() || 'Student',
          gradeDivision: studentPlaceLabel(st, labels),
          rollNumber: st.rollNumber,
          camOn,
        });
      } else {
        students.push({
          id: identity,
          identity,
          name: row?.displayName?.trim() || 'Guest',
          gradeDivision: 'Guest',
          rollNumber: null,
          camOn,
        });
      }
    }
  } else {
    const studentIds = 'openStudentIds' in p ? (p.openStudentIds ?? []) : [];
    const [found, partRows] = studentIds.length
      ? await Promise.all([
          prisma.student.findMany({
            where: { id: { in: studentIds } },
            select: { id: true, name: true, campus: true, grade: true, division: true, rollNumber: true },
          }),
          prisma.participant.findMany({
            where: { roomId: room.id, studentId: { in: studentIds }, role: 'STUDENT', status: 'ADMITTED' },
            orderBy: { createdAt: 'desc' },
            select: { studentId: true, livekitIdentity: true },
          }),
        ])
      : [[], []];
    const byId = new Map(found.map((s) => [s.id, s]));
    const identityByStudentId = new Map<string, string>();
    for (const pr of partRows) {
      if (pr.studentId && !identityByStudentId.has(pr.studentId)) {
        identityByStudentId.set(pr.studentId, pr.livekitIdentity);
      }
    }
    students = studentIds.map((id) => {
      const s = byId.get(id);
      const identity = identityByStudentId.get(id) ?? id;
      const camOn = camMap.get(identity) === true;
      return s
        ? {
            id: s.id,
            identity,
            name: s.name.trim() || 'Student',
            gradeDivision: studentPlaceLabel(s, labels),
            rollNumber: s.rollNumber,
            camOn,
          }
        : { id, identity, name: 'Student', gradeDivision: 'Guest', rollNumber: null, camOn };
    });
  }
  students.sort((a, b) => naturalCompare(a.name, b.name));
  // The heading on the class page is students.length. Keep it equal to the card.
  const liveClass = { ...toLiveClass(room, cs, p, labels), studentCount: students.length };
  return {
    liveClass,
    roomName: livekitRoomName(room.code, room.sessionId),
    students,
  };
}
