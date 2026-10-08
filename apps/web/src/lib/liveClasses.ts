import type { ClassSession, Room } from '@prisma/client';
import { prisma } from './db';
import { formatAudience } from './grades';
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

type RoomWithTeacher = Room & { teacher: { name: string } };

export type LiveRosterStudent = { id: string; name: string; gradeDivision: string; rollNumber: string | null };

async function ongoingPairs(code?: string): Promise<{ room: RoomWithTeacher; cs: ClassSession }[]> {
  const rooms = await prisma.room.findMany({
    where: { status: { not: 'ENDED' }, classSessionId: { not: null }, ...(code ? { code } : {}) },
    include: { teacher: { select: { name: true } } },
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
    const s = summarizeRoomParticipants(await listRoomParticipants({ code: room.code, sessionId: room.sessionId }));
    return { ...s, countSource: 'livekit' as const };
  } catch (e) {
    console.warn('live classes: LiveKit unavailable, using attendance', room.code, e instanceof Error ? e.message : e);
    const open = await prisma.attendanceRecord.findMany({
      where: { classSessionId: cs.id, connectedSince: { not: null } },
      select: { studentId: true },
    });
    return {
      studentIdentities: null as string[] | null,
      openStudentIds: open.map((r) => r.studentId),
      studentCount: open.length,
      teacherConnected: null,
      countSource: 'attendance' as const,
    };
  }
}

function toLiveClass(room: RoomWithTeacher, cs: ClassSession, p: Awaited<ReturnType<typeof presence>>): LiveClass {
  return {
    code: room.code,
    sessionId: room.sessionId,
    classSessionId: cs.id,
    title: room.name,
    subject: cs.subject,
    gradeDivision: formatAudience(cs.campus, cs.grade, cs.divisions, cs.allDivisions),
    campus: cs.campus,
    teacherName: room.teacher.name,
    startedAt: cs.startedAt!.toISOString(),
    studentCount: p.studentCount,
    teacherConnected: p.teacherConnected,
    countSource: p.countSource,
  };
}

export async function listLiveClasses(): Promise<LiveClass[]> {
  const pairs = await ongoingPairs();
  const out = await Promise.all(pairs.map(async ({ room, cs }) => toLiveClass(room, cs, await presence(room, cs))));
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** One ongoing class plus the students currently connected (names only: no media). */
export async function getLiveClass(
  code: string
): Promise<{ liveClass: LiveClass; roomName: string; students: LiveRosterStudent[] } | null> {
  const [pair] = await ongoingPairs(code);
  if (!pair) return null;
  const { room, cs } = pair;
  const p = await presence(room, cs);

  let studentIds: string[] = [];
  if (p.studentIdentities) {
    const rows = p.studentIdentities.length
      ? await prisma.participant.findMany({
          where: { roomId: room.id, livekitIdentity: { in: p.studentIdentities }, studentId: { not: null } },
          select: { studentId: true },
        })
      : [];
    studentIds = [...new Set(rows.map((r) => r.studentId!))];
  } else {
    studentIds = 'openStudentIds' in p ? (p.openStudentIds ?? []) : [];
  }
  const students = studentIds.length
    ? await prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, name: true, campus: true, grade: true, division: true, rollNumber: true },
        orderBy: { name: 'asc' },
      })
    : [];
  return {
    liveClass: toLiveClass(room, cs, p),
    roomName: livekitRoomName(room.code, room.sessionId),
    students: students.map((s) => ({
      id: s.id,
      name: s.name,
      gradeDivision: `${s.campus} · ${s.grade}-${s.division}`,
      rollNumber: s.rollNumber,
    })),
  };
}
