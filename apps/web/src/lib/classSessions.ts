import type { ClassSession, Room } from '@prisma/client';
import { prisma } from './db';
import { audienceUnknownMessage } from './gradeMaster';
import { canTeachAudience, formatAudience, normalizeCampus, normalizeGrade, parseDivisionList } from './grades';
import { campusUnknownMessage } from './campusMaster';
import { findOccurrence, occurrencesForDate } from './scheduleService';
import { dateValue, formatHHMM, localDateOf, phaseOf, type Occurrence } from './schedule';
import { appTimeZone, earlyWindowMinutes } from './schoolConfig';
import { endRoom, ensureTeacherPermanentCode, startOrReopenTeacherRoom } from './teacherRoom';
import { getTeacherAssignments } from './teachers';
import { refreshLateFlags } from './attendanceService';

export class SessionError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type TeacherRef = { id: string; name: string; permanentCode?: string | null };
type StartOpts = { maxVisibleVideos?: number; name?: string };

export function sessionTitle(s: { subject: string; campus: string; grade: string; divisions: string[]; allDivisions: boolean }) {
  return `${s.subject} · ${formatAudience(s.campus, s.grade, s.divisions, s.allDivisions)}`;
}

/** ClassSession row for a timetable occurrence (created on first use; refreshed from overrides). */
export async function upsertOccurrenceSession(occ: Occurrence): Promise<ClassSession> {
  const data = {
    slotId: occ.slotId,
    overrideId: occ.overrideId,
    sessionDate: dateValue(occ.date),
    teacherId: occ.teacherId,
    campus: occ.campus,
    grade: occ.grade,
    divisions: occ.divisions,
    allDivisions: occ.allDivisions,
    subject: occ.subject,
    scheduledStart: occ.start,
    scheduledEnd: occ.end,
  };
  try {
    return await prisma.classSession.upsert({
      where: { occurrenceKey: occ.key },
      create: { occurrenceKey: occ.key, adHoc: false, ...data },
      update: data,
    });
  } catch (e) {
    // Concurrent create of the same occurrence (teacher + first student at once).
    if ((e as { code?: string }).code === 'P2002') {
      const row = await prisma.classSession.findUnique({ where: { occurrenceKey: occ.key } });
      if (row) return row;
    }
    throw e;
  }
}

/**
 * Point the teacher's permanent room at this class session. A different class
 * still running in the room is ended first (one class at a time per teacher).
 */
async function openRoomForSession(
  teacher: TeacherRef,
  cs: ClassSession,
  opts: StartOpts
): Promise<{ room: Room; classSession: ClassSession }> {
  const code = teacher.permanentCode || (await ensureTeacherPermanentCode(teacher.id));
  const existing = await prisma.room.findUnique({ where: { code } });
  if (existing && existing.status !== 'ENDED' && existing.classSessionId !== cs.id) {
    await endRoom(existing);
  }
  let room = await startOrReopenTeacherRoom(
    { id: teacher.id, name: teacher.name, permanentCode: code },
    { name: opts.name || sessionTitle(cs), maxVisibleVideos: opts.maxVisibleVideos }
  );
  if (room.classSessionId !== cs.id) {
    room = await prisma.room.update({ where: { id: room.id }, data: { classSessionId: cs.id, waitingRoomOn: true } });
  }
  const classSession = await prisma.classSession.update({
    where: { id: cs.id },
    data: { roomId: room.id, startedAt: cs.startedAt ?? new Date(), endedAt: null },
  });
  if (!cs.startedAt) await refreshLateFlags(classSession);
  return { room, classSession };
}

/** Start (or re-enter / reopen the same day) a timetabled class. */
export async function startScheduledClass(teacher: TeacherRef, key: string, opts: StartOpts = {}) {
  const tz = appTimeZone();
  const occ = await findOccurrence(key, tz);
  if (!occ) throw new SessionError('This class is not on the timetable (it may have been cancelled).', 404);
  if (occ.teacherId !== teacher.id) throw new SessionError('This class is assigned to another teacher.', 403);
  const now = new Date();
  const early = earlyWindowMinutes();
  const phase = phaseOf(occ, now, early);
  if (phase === 'upcoming') {
    throw new SessionError(
      `You can open this class from ${formatHHMM(Math.max(0, occ.startMinute - early))} (${early} min before it starts).`,
      409
    );
  }
  if (phase === 'past') {
    const prior = await prisma.classSession.findUnique({ where: { occurrenceKey: occ.key } });
    // Re-entering a class that was started and is still running past its end is fine.
    if (!prior?.startedAt || prior.endedAt) {
      throw new SessionError('This class time is over. Start an ad-hoc class instead.', 409);
    }
  }
  const cs = await upsertOccurrenceSession(occ);
  return openRoomForSession(teacher, cs, opts);
}

/** Ad-hoc class, only for the teacher's assigned grades/divisions. */
export async function startAdHocClass(
  teacher: TeacherRef,
  input: { campus: string; grade: string; divisions: string[] | string; allDivisions?: boolean; subject?: string },
  opts: StartOpts = {}
) {
  const campus = normalizeCampus(input.campus);
  const grade = normalizeGrade(input.grade);
  if (!campus) throw new SessionError('Pick a campus.', 400);
  const parsed = input.allDivisions
    ? { divisions: [], allDivisions: true }
    : parseDivisionList(input.divisions);
  const assignments = await getTeacherAssignments(teacher.id);
  if (!canTeachAudience(assignments, campus, grade, parsed.divisions, parsed.allDivisions)) {
    throw new SessionError('You can only start classes for your assigned campus, grades and divisions.', 403);
  }
  const campusUnknown = await campusUnknownMessage(campus);
  if (campusUnknown) throw new SessionError(campusUnknown.replace(' Add it there first.', ' Ask the admin to add it.'), 400);
  // Whole-grade ("*") teachers pick divisions from Grades & divisions; explicitly
  // assigned divisions were already checked when the admin assigned them.
  const explicit = new Set(
    assignments.filter((a) => a.campus === campus && normalizeGrade(a.grade) === grade).map((a) => a.division)
  );
  if (!parsed.allDivisions && parsed.divisions.some((d) => !explicit.has(d))) {
    const unknown = await audienceUnknownMessage(grade, parsed.divisions, false);
    if (unknown) throw new SessionError(unknown.replace(' Add it there first.', ' Ask the admin to add it.'), 400);
  }
  const subject = (input.subject || '').trim().slice(0, 80) || 'Class';

  // Re-pressing Start for the same running ad-hoc class re-enters it.
  const code = teacher.permanentCode || (await ensureTeacherPermanentCode(teacher.id));
  const room = await prisma.room.findUnique({ where: { code } });
  if (room && room.status !== 'ENDED' && room.classSessionId) {
    const current = await prisma.classSession.findUnique({ where: { id: room.classSessionId } });
    if (
      current &&
      current.adHoc &&
      !current.endedAt &&
      current.campus === campus &&
      current.grade === grade &&
      current.allDivisions === parsed.allDivisions &&
      current.divisions.join(',') === parsed.divisions.join(',') &&
      current.subject === subject
    ) {
      return openRoomForSession(teacher, current, opts);
    }
  }

  const cs = await prisma.classSession.create({
    data: {
      adHoc: true,
      sessionDate: dateValue(localDateOf(new Date(), appTimeZone())),
      teacherId: teacher.id,
      campus,
      grade,
      divisions: parsed.divisions,
      allDivisions: parsed.allDivisions,
      subject,
    },
  });
  return openRoomForSession(teacher, cs, opts);
}

/**
 * Legacy "Start class" (POST /api/rooms/create, used by the Android app):
 * re-enter whatever is open; else the teacher's timetabled class open now;
 * else an ad-hoc class when the teacher has a single assigned grade.
 */
export async function startDefaultClass(teacher: TeacherRef, opts: StartOpts = {}) {
  const code = teacher.permanentCode || (await ensureTeacherPermanentCode(teacher.id));
  const room = await prisma.room.findUnique({ where: { code } });
  if (room && room.status !== 'ENDED') {
    const current = room.classSessionId
      ? await prisma.classSession.findUnique({ where: { id: room.classSessionId } })
      : null;
    if (current && !current.endedAt) return openRoomForSession(teacher, current, opts);
  }

  const tz = appTimeZone();
  const now = new Date();
  const early = earlyWindowMinutes();
  const mine = (await occurrencesForDate(localDateOf(now, tz), tz)).filter(
    (o) => o.teacherId === teacher.id && phaseOf(o, now, early) === 'open'
  );
  if (mine.length) return startScheduledClass(teacher, mine[0]!.key, opts);

  const assignments = await getTeacherAssignments(teacher.id);
  const grades = [...new Set(assignments.map((a) => `${a.campus}|${a.grade}`))];
  if (grades.length === 1) {
    const [c, g] = grades[0]!.split('|') as [string, string];
    const divs = assignments.filter((a) => a.campus === c && a.grade === g).map((a) => a.division);
    return startAdHocClass(
      teacher,
      { campus: c, grade: g, divisions: divs, allDivisions: divs.includes('*'), subject: opts.name },
      opts
    );
  }
  if (!grades.length) {
    throw new SessionError('No grades are assigned to you yet. Ask the school administrator.', 403);
  }
  throw new SessionError('Choose the grade and divisions for this class on the web dashboard.', 400);
}
