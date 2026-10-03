import type { ClassSession, Room, Student } from '@prisma/client';
import { prisma } from './db';
import { setActAsStudent, setStudentCookie } from './auth';
import { generateIdentity, generateSessionToken } from './codes';
import { audienceIncludes, formatAudience, normalizeDivision, normalizeGrade } from './grades';
import { ensureRedis, keys } from './redis';
import { recordArrival } from './attendanceService';
import { upsertOccurrenceSession } from './classSessions';
import { occurrencesForRange } from './scheduleService';
import { addDays, forAudience, formatHHMM, localDateOf, type Occurrence } from './schedule';
import { appTimeZone, earlyWindowMinutes } from './schoolConfig';
import { decideRoute, routeSignature, type SessionState } from './studentRouting';
import type { JoinClaims } from './schoolJwt';

type StudentStore = {
  student: {
    upsert: (args: {
      where: { externalId: string };
      create: Record<string, unknown> & { externalId: string };
      update: Record<string, unknown>;
    }) => Promise<Student>;
    update: (args: { where: { externalId: string }; data: Record<string, unknown> }) => Promise<Student>;
  };
};

/**
 * Create/refresh the student from join claims (signed JWT or unsigned link),
 * keyed on the school's permanent student ID (externalId = SID). Later joins
 * update name / grade / division (e.g. promotion to a new grade). Optional
 * fields (roll, email, phone) are only overwritten when the link carries them.
 */
export async function upsertStudentFromClaims(c: JoinClaims, db: StudentStore = prisma as unknown as StudentStore): Promise<Student> {
  const data = {
    name: c.name,
    grade: c.grade,
    division: c.division,
    ...(c.rollNumber ? { rollNumber: c.rollNumber } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    lastSeenAt: new Date(),
  };
  try {
    return await db.student.upsert({
      where: { externalId: c.studentId },
      create: { externalId: c.studentId, source: 'join', ...data },
      update: data,
    });
  } catch (e) {
    // Two first joins racing: the loser updates the row the winner created.
    if ((e as { code?: string }).code === 'P2002') {
      return db.student.update({ where: { externalId: c.studentId }, data });
    }
    throw e;
  }
}

/** Is this room currently running this class session? */
function roomRuns(room: Room | null | undefined, cs: { id: string }): room is Room {
  return !!room && room.status !== 'ENDED' && room.classSessionId === cs.id;
}

/**
 * Put the student in the class's waiting room (or reuse their open seat) and
 * give this browser the per-class participant cookie.
 */
export async function ensureStudentParticipant(student: Student, room: Room, cs: ClassSession) {
  let participant = await prisma.participant.findFirst({
    where: { roomId: room.id, studentId: student.id, classSessionId: cs.id, status: { not: 'LEFT' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!participant) {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    // A student re-joining the same class on another device keeps the
    // teacher's pin on their video.
    const previous = await prisma.participant.findFirst({
      where: { roomId: room.id, studentId: student.id, classSessionId: cs.id, pinnedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { pinnedAt: true },
    });
    participant = await prisma.participant.create({
      data: {
        roomId: room.id,
        displayName: student.name,
        role: 'STUDENT',
        status: 'WAITING',
        livekitIdentity: generateIdentity('student', id),
        sessionToken: generateSessionToken(),
        studentId: student.id,
        classSessionId: cs.id,
        // Students join muted; the teacher unmutes one by one or with Allow unmute.
        mutedByTeacher: true,
        pinnedAt: previous?.pinnedAt ?? null,
      },
    });
    const redis = await ensureRedis();
    await redis.sadd(keys.waiting(room.code), participant.id);
  } else if (participant.displayName !== student.name) {
    participant = await prisma.participant.update({ where: { id: participant.id }, data: { displayName: student.name } });
  }
  await setStudentCookie(participant.sessionToken);
  await setActAsStudent();
  return participant;
}

/** Arrive at a class session: attendance + waiting room if the teacher has opened it. */
async function arrive(student: Student, cs: ClassSession) {
  await recordArrival(cs, student.id);
  const room = cs.roomId ? await prisma.room.findUnique({ where: { id: cs.roomId } }) : null;
  if (roomRuns(room, cs)) {
    const p = await ensureStudentParticipant(student, room, cs);
    return { room, participant: p };
  }
  return { room: null, participant: null };
}

export type StudentRoutePayload =
  | { kind: 'room'; waitingUrl: string; cls: ClassInfo }
  | { kind: 'waiting_for_teacher'; cls: ClassInfo }
  | { kind: 'upcoming'; cls: ClassInfo; opensAt: string }
  | { kind: 'ended'; cls: ClassInfo; next: ClassInfo | null }
  | { kind: 'none'; next: ClassInfo | null };

export type ClassInfo = {
  subject: string;
  audience: string;
  teacherName: string | null;
  date: string;
  start: string | null;
  end: string | null;
  startLabel: string | null;
  endLabel: string | null;
};

async function teacherName(id: string) {
  return (await prisma.teacher.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
}

async function occInfo(o: Occurrence): Promise<ClassInfo> {
  return {
    subject: o.subject,
    audience: formatAudience(o.grade, o.divisions, o.allDivisions),
    teacherName: await teacherName(o.teacherId),
    date: o.date,
    start: o.start.toISOString(),
    end: o.end.toISOString(),
    startLabel: formatHHMM(o.startMinute),
    endLabel: formatHHMM(o.endMinute),
  };
}

async function sessionInfo(cs: ClassSession): Promise<ClassInfo> {
  return {
    subject: cs.subject,
    audience: formatAudience(cs.grade, cs.divisions, cs.allDivisions),
    teacherName: await teacherName(cs.teacherId),
    date: cs.sessionDate.toISOString().slice(0, 10),
    start: (cs.scheduledStart ?? cs.startedAt)?.toISOString() ?? null,
    end: cs.scheduledEnd?.toISOString() ?? null,
    startLabel: null,
    endLabel: null,
  };
}

/**
 * The routing decision for a student right now, with no side effects (no
 * check-in, no ClassSession created). Shared by routeStudent and the
 * lightweight /api/student/check poll.
 */
export async function decideStudentRoute(student: Student) {
  const tz = appTimeZone();
  const early = earlyWindowMinutes();
  const now = new Date();
  const today = localDateOf(now, tz);
  const grade = normalizeGrade(student.grade);
  const division = normalizeDivision(student.division);

  // Yesterday too, so a class running past midnight is still found.
  const occurrences = forAudience(await occurrencesForRange(addDays(today, -1), addDays(today, 7), tz), grade, division);

  const [sessions, liveRooms] = await Promise.all([
    prisma.classSession.findMany({ where: { occurrenceKey: { in: occurrences.map((o) => o.key) } }, include: { room: true } }),
    prisma.room.findMany({ where: { status: { not: 'ENDED' }, classSessionId: { not: null } }, select: { classSessionId: true } }),
  ]);
  const states = new Map<string, SessionState>();
  for (const s of sessions) {
    states.set(s.occurrenceKey!, { id: s.id, live: roomRuns(s.room, s), startedAt: s.startedAt, endedAt: s.endedAt });
  }
  const liveIds = liveRooms.map((r) => r.classSessionId!);
  const adHoc = (
    await prisma.classSession.findMany({
      where: { id: { in: liveIds }, adHoc: true, endedAt: null, grade },
      orderBy: { startedAt: 'asc' },
    })
  ).filter((s) => audienceIncludes(s, grade, division));

  const decision = decideRoute({
    occurrences,
    sessions: states,
    liveAdHoc: adHoc.map((s) => ({ id: s.id, subject: s.subject, startedAt: s.startedAt })),
    now,
    earlyMinutes: early,
    today,
  });
  return { decision, adHoc };
}

/**
 * Route a signed-in student by the timetable (and live ad-hoc classes of their
 * grade-division), checking them in when a class is open. Called by the
 * /student page whenever /api/student/check reports a change; idempotent.
 */
export async function routeStudent(student: Student): Promise<StudentRoutePayload & { sig: string }> {
  const { decision, adHoc } = await decideStudentRoute(student);
  const sig = routeSignature(decision);
  return { ...(await payloadFor(student, decision, adHoc)), sig };
}

async function payloadFor(
  student: Student,
  decision: Awaited<ReturnType<typeof decideStudentRoute>>['decision'],
  adHoc: ClassSession[]
): Promise<StudentRoutePayload> {
  if (decision.kind === 'adhoc') {
    const cs = adHoc.find((s) => s.id === decision.session.id)!;
    const { room } = await arrive(student, cs);
    const info = await sessionInfo(cs);
    return room ? { kind: 'room', waitingUrl: `/join/${room.code}?waiting=1&as=student`, cls: info } : { kind: 'waiting_for_teacher', cls: info };
  }
  if (decision.kind === 'scheduled') {
    const cs = await upsertOccurrenceSession(decision.occurrence);
    const { room } = await arrive(student, cs);
    const info = await occInfo(decision.occurrence);
    return room ? { kind: 'room', waitingUrl: `/join/${room.code}?waiting=1&as=student`, cls: info } : { kind: 'waiting_for_teacher', cls: info };
  }
  if (decision.kind === 'upcoming') {
    return { kind: 'upcoming', cls: await occInfo(decision.occurrence), opensAt: decision.opensAt.toISOString() };
  }
  if (decision.kind === 'ended') {
    return { kind: 'ended', cls: await occInfo(decision.occurrence), next: decision.next ? await occInfo(decision.next) : null };
  }
  return { kind: 'none', next: decision.next ? await occInfo(decision.next) : null };
}

/**
 * May this school-app student enter this room's current class? Used to stop a
 * student entering another grade/division's class with a teacher's meeting code.
 */
export async function studentMayEnterRoom(student: Student, room: Room) {
  if (!room.classSessionId) return { ok: false as const, cs: null };
  const cs = await prisma.classSession.findUnique({ where: { id: room.classSessionId } });
  if (!cs || cs.endedAt) return { ok: false as const, cs: null };
  return { ok: audienceIncludes(cs, student.grade, student.division), cs };
}

export { arrive as arriveAtSession };
