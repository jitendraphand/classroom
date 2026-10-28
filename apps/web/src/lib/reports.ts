import type { AttendanceRecord, ClassSession, Prisma, Student } from '@prisma/client';
import { prisma } from './db';
import { attendanceStatus, STATUS_LABEL, tallyAttendance, totalConnectedMs, type AttendanceStatus } from './attendance';
import { toCsv, type Cell } from './csv';
import { audienceIncludes, formatAudience, normalizeCampus, normalizeDivision, normalizeGrade } from './grades';
import { isAcademicYearLabel } from './academicYear';
import { occurrenceBaseKey } from './occurrenceRuns';
import { addDays, dateOnly, dateValue, daysBetween, formatHHMM, isLocalDate, localDateOf, localMinuteOf } from './schedule';
import { occurrencesForRange } from './scheduleService';
import { appTimeZone } from './schoolConfig';

export type ReportFilter = {
  from: string;
  to: string;
  teacherId?: string;
  campus?: string;
  grade?: string;
  division?: string;
  subject?: string;
  classSessionId?: string;
  academicYear?: string;
};

export class ReportError extends Error {}

export const MAX_RANGE_DAYS = 366;

export function parseReportFilter(url: URL, opts: { forceTeacherId?: string } = {}): ReportFilter {
  const tz = appTimeZone();
  const today = localDateOf(new Date(), tz);
  const from = url.searchParams.get('from') || addDays(today, -30);
  const to = url.searchParams.get('to') || today;
  if (!isLocalDate(from) || !isLocalDate(to)) throw new ReportError('Use YYYY-MM-DD dates');
  if (from > to) throw new ReportError('"From" must be before "to"');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new ReportError(`Pick at most ${MAX_RANGE_DAYS} days`);
  const c = url.searchParams.get('campus');
  const g = url.searchParams.get('grade');
  const d = url.searchParams.get('division');
  return {
    from,
    to,
    teacherId: opts.forceTeacherId ?? (url.searchParams.get('teacherId') || undefined),
    campus: c ? normalizeCampus(c) || undefined : undefined,
    grade: g ? normalizeGrade(g) : undefined,
    division: d ? normalizeDivision(d) : undefined,
    subject: url.searchParams.get('subject')?.trim() || undefined,
    classSessionId: url.searchParams.get('sessionId') || undefined,
    academicYear: isAcademicYearLabel(url.searchParams.get('year') || '') ? url.searchParams.get('year')! : undefined,
  };
}

/** Only the attendance columns reports read (no SID arrays). */
const ATTENDANCE_FIELDS = {
  studentId: true,
  firstJoinedAt: true,
  admittedAt: true,
  leftAt: true,
  connectedMs: true,
  connectedSince: true,
  late: true,
} as const;
type ReportAttendance = Pick<
  AttendanceRecord,
  'studentId' | 'firstJoinedAt' | 'admittedAt' | 'leftAt' | 'connectedMs' | 'connectedSince' | 'late'
>;
type SessionWith = ClassSession & { attendance: ReportAttendance[]; teacher: { name: string } };

/** Sessions per page: bounds memory for a year-long report on a small box. */
const SESSION_PAGE = 200;

function sessionWhere(f: ReportFilter): Prisma.ClassSessionWhereInput {
  return {
    sessionDate: { gte: dateValue(f.from), lte: dateValue(f.to) },
    ...(f.teacherId ? { teacherId: f.teacherId } : {}),
    ...(f.campus ? { campus: f.campus } : {}),
    ...(f.grade ? { grade: f.grade } : {}),
    ...(f.subject ? { subject: { contains: f.subject, mode: 'insensitive' } } : {}),
    ...(f.division ? { OR: [{ allDivisions: true }, { divisions: { has: f.division } }] } : {}),
    ...(f.classSessionId ? { id: f.classSessionId } : {}),
    ...(f.academicYear ? { academicYear: f.academicYear } : {}),
  };
}

const SESSION_ORDER: Prisma.ClassSessionOrderByWithRelationInput[] = [
  { sessionDate: 'asc' },
  { scheduledStart: 'asc' },
  { startedAt: 'asc' },
  { id: 'asc' },
];

/**
 * Matching sessions, a page at a time (with their attendance), yielding to the
 * event loop between pages so a long report does not stall the live classes
 * this worker also serves.
 */
async function* sessionPages(f: ReportFilter, extra: Prisma.ClassSessionWhereInput = {}): AsyncGenerator<SessionWith[]> {
  const where = { ...sessionWhere(f), ...extra };
  let skip = 0;
  for (;;) {
    const page = await prisma.classSession.findMany({
      where,
      include: { attendance: { select: ATTENDANCE_FIELDS }, teacher: { select: { name: true } } },
      orderBy: SESSION_ORDER,
      skip,
      take: SESSION_PAGE,
    });
    if (!page.length) return;
    yield page;
    if (page.length < SESSION_PAGE) return;
    skip += page.length;
    await new Promise((r) => setImmediate(r));
  }
}

type ReportStudent = Pick<Student, 'id' | 'externalId' | 'name' | 'campus' | 'grade' | 'division' | 'rollNumber' | 'createdAt' | 'deletedAt'>;
const STUDENT_FIELDS = {
  id: true,
  externalId: true,
  name: true,
  campus: true,
  grade: true,
  division: true,
  rollNumber: true,
  createdAt: true,
  deletedAt: true,
} as const;

/** Students of the given grades, indexed by canonical campus|grade (audience lookups touch one group). */
async function loadStudentIndex(grades: string[]): Promise<Map<string, ReportStudent[]>> {
  const index = new Map<string, ReportStudent[]>();
  if (!grades.length) return index;
  const rows = await prisma.student.findMany({ where: { grade: { in: grades } }, select: STUDENT_FIELDS });
  for (const s of rows) {
    const k = `${normalizeCampus(s.campus)}|${normalizeGrade(s.grade)}`;
    const list = index.get(k) ?? [];
    list.push(s);
    index.set(k, list);
  }
  return index;
}

async function sessionGrades(f: ReportFilter, extra: Prisma.ClassSessionWhereInput = {}): Promise<string[]> {
  const rows = await prisma.classSession.findMany({ where: { ...sessionWhere(f), ...extra }, distinct: ['grade'], select: { grade: true } });
  return rows.map((r) => r.grade);
}

/** Students the system knew for this session's audience by the time it ended. */
function knownStudents(cs: ClassSession, index: Map<string, ReportStudent[]>, division?: string) {
  const cutoff = (cs.endedAt ?? cs.scheduledEnd ?? new Date()).getTime();
  const group = index.get(`${normalizeCampus(cs.campus)}|${normalizeGrade(cs.grade)}`) ?? [];
  return group.filter(
    (s) =>
      audienceIncludes(cs, s) &&
      s.createdAt.getTime() <= cutoff &&
      // A student the admin deleted still counts for classes before the deletion.
      (!s.deletedAt || s.deletedAt.getTime() > cutoff) &&
      (!division || normalizeDivision(s.division) === division)
  );
}

function hhmm(d: Date | null | undefined, tz: string) {
  return d ? formatHHMM(localMinuteOf(d, tz)) : '';
}

function sessionStatus(cs: { startedAt: Date | null; endedAt: Date | null; scheduledEnd: Date | null }, now: Date) {
  if (cs.startedAt) return cs.endedAt ? 'Held' : 'In progress';
  if (cs.scheduledEnd && cs.scheduledEnd.getTime() < now.getTime()) return 'Not held';
  return 'Not started';
}

// ------------------------------------------------------------ per session

export type SessionRow = {
  sessionId: string | null;
  date: string;
  subject: string;
  teacher: string;
  audience: string;
  type: 'Timetable' | 'Extra' | 'Ad-hoc';
  scheduledStart: string;
  scheduledEnd: string;
  startedAt: string;
  endedAt: string;
  startDelayMin: number | null;
  status: string;
  present: number;
  late: number;
  notAdmitted: number;
  absent: number;
  knownStudents: number;
};

export async function sessionSummary(f: ReportFilter): Promise<SessionRow[]> {
  const tz = appTimeZone();
  const now = new Date();
  const students = await loadStudentIndex(await sessionGrades(f));
  const teacherNames = new Map(
    (await prisma.teacher.findMany({ select: { id: true, name: true } })).map((t) => [t.id, t.name])
  );

  const rows: SessionRow[] = [];
  const have = new Set<string>();
  for await (const page of sessionPages(f)) {
    for (const cs of page) {
      if (cs.occurrenceKey) have.add(occurrenceBaseKey(cs.occurrenceKey));
      rows.push(sessionRow(cs, students, f, tz, now));
    }
  }
  await appendNotHeld(rows, have, f, teacherNames, tz, now);
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.scheduledStart || a.startedAt).localeCompare(b.scheduledStart || b.startedAt));
}

function sessionRow(cs: SessionWith, students: Map<string, ReportStudent[]>, f: ReportFilter, tz: string, now: Date): SessionRow {
  const known = knownStudents(cs, students, f.division);
  const knownIds = new Set(known.map((s) => s.id));
  const recs = cs.attendance.filter((r) => !f.division || knownIds.has(r.studentId));
  const seen = new Set<string>();
  for (const r of recs) {
    if (r.studentId) seen.add(r.studentId);
  }
  const counts = tallyAttendance(recs.map((r) => ({ studentId: r.studentId, status: attendanceStatus(r) })));
  const absent = cs.startedAt ? known.filter((s) => !seen.has(s.id)).length : 0;
  return {
    sessionId: cs.id,
    date: dateOnly(cs.sessionDate)!,
    subject: cs.subject,
    teacher: cs.teacher.name,
    audience: formatAudience(cs.campus, cs.grade, cs.divisions, cs.allDivisions),
    type: cs.adHoc ? 'Ad-hoc' : cs.slotId ? 'Timetable' : 'Extra',
    scheduledStart: hhmm(cs.scheduledStart, tz),
    scheduledEnd: hhmm(cs.scheduledEnd, tz),
    startedAt: hhmm(cs.startedAt, tz),
    endedAt: hhmm(cs.endedAt, tz),
    startDelayMin:
      cs.startedAt && cs.scheduledStart ? Math.round((cs.startedAt.getTime() - cs.scheduledStart.getTime()) / 60_000) : null,
    status: sessionStatus(cs, now),
    ...counts,
    absent,
    knownStudents: known.length,
  };
}

/** Timetabled classes that never got a session row (nobody opened them). */
async function appendNotHeld(
  rows: SessionRow[],
  have: Set<string>,
  f: ReportFilter,
  teacherNames: Map<string, string>,
  tz: string,
  now: Date
) {
  if (!f.classSessionId) {
    const today = localDateOf(now, tz);
    const to = f.to < today ? f.to : today;
    if (f.from <= to) {
      const allKeys = new Set(
        (await prisma.classSession.findMany({
          where: { sessionDate: { gte: dateValue(f.from), lte: dateValue(to) }, occurrenceKey: { not: null } },
          select: { occurrenceKey: true },
        })).map((s) => s.occurrenceKey && occurrenceBaseKey(s.occurrenceKey)).filter((k): k is string => !!k)
      );
      const occs = await occurrencesForRange(f.from, to, tz);
      // A slot/extra class added today must not report its past weeks as "Not held".
      const createdAt = new Map<string, number>();
      const slotIds = [...new Set(occs.map((o) => o.slotId).filter((x): x is string => !!x))];
      const overrideIds = [...new Set(occs.filter((o) => o.extra && o.overrideId).map((o) => o.overrideId!))];
      for (const r of await prisma.timetableSlot.findMany({ where: { id: { in: slotIds } }, select: { id: true, createdAt: true } })) {
        createdAt.set(`slot:${r.id}`, r.createdAt.getTime());
      }
      for (const r of await prisma.scheduleOverride.findMany({ where: { id: { in: overrideIds } }, select: { id: true, createdAt: true } })) {
        createdAt.set(`override:${r.id}`, r.createdAt.getTime());
      }
      for (const o of occs) {
        if (have.has(o.key) || allKeys.has(o.key)) continue;
        if (o.end.getTime() > now.getTime()) continue;
        const born = createdAt.get(o.extra ? `override:${o.overrideId}` : `slot:${o.slotId}`);
        if (born != null && o.end.getTime() < born) continue;
        if (f.teacherId && o.teacherId !== f.teacherId) continue;
        if (f.campus && o.campus !== f.campus) continue;
        if (f.grade && o.grade !== f.grade) continue;
        if (f.division && !audienceIncludes(o, { campus: o.campus, grade: o.grade, division: f.division })) continue;
        if (f.subject && !o.subject.toLowerCase().includes(f.subject.toLowerCase())) continue;
        rows.push({
          sessionId: null,
          date: o.date,
          subject: o.subject,
          teacher: teacherNames.get(o.teacherId) ?? '',
          audience: formatAudience(o.campus, o.grade, o.divisions, o.allDivisions),
          type: o.extra ? 'Extra' : 'Timetable',
          scheduledStart: formatHHMM(o.startMinute),
          scheduledEnd: formatHHMM(o.endMinute),
          startedAt: '',
          endedAt: '',
          startDelayMin: null,
          status: 'Not held',
          present: 0,
          late: 0,
          notAdmitted: 0,
          absent: 0,
          knownStudents: 0,
        });
      }
    }
  }
}

export function sessionSummaryCsv(rows: SessionRow[]) {
  return toCsv(
    ['Date', 'Subject', 'Teacher', 'Grade-division', 'Type', 'Scheduled start', 'Scheduled end', 'Started', 'Ended', 'Start delay (min)', 'Status', 'Present', 'Late', 'Waited not admitted', 'Absent (known students)', 'Known students'],
    rows.map((r) => [r.date, r.subject, r.teacher, r.audience, r.type, r.scheduledStart, r.scheduledEnd, r.startedAt, r.endedAt, r.startDelayMin, r.status, r.present, r.late, r.notAdmitted, r.absent, r.knownStudents])
  );
}

// ------------------------------------------------------------ per student per session

export type DetailRow = {
  sessionId: string;
  date: string;
  subject: string;
  teacher: string;
  audience: string;
  studentId: string;
  externalId: string;
  name: string;
  rollNumber: string;
  gradeDivision: string;
  status: AttendanceStatus;
  statusLabel: string;
  firstJoined: string;
  admitted: string;
  left: string;
  connectedMin: number;
};

/**
 * Every (session, student) detail row, handed to `emit` one at a time and a
 * page of sessions at a time, so a year-long report never holds every session,
 * attendance record and row in memory at once.
 */
async function forEachDetailRow(f: ReportFilter, emit: (row: DetailRow) => void): Promise<void> {
  const tz = appTimeZone();
  const now = new Date();
  const started = { startedAt: { not: null } } as const;
  const index = await loadStudentIndex(await sessionGrades(f, started));
  const byId = new Map<string, ReportStudent>();
  for (const list of index.values()) for (const st of list) byId.set(st.id, st);

  for await (const page of sessionPages(f, started)) {
    // Students with a record but outside the audience grade (manual / moved).
    const missing = [...new Set(page.flatMap((cs) => cs.attendance.map((r) => r.studentId)))].filter((id) => !byId.has(id));
    if (missing.length) {
      for (const st of await prisma.student.findMany({ where: { id: { in: missing } }, select: STUDENT_FIELDS })) byId.set(st.id, st);
    }
    for (const cs of page) {
      const recBy = new Map(cs.attendance.map((r) => [r.studentId, r]));
      const ids = new Set([...knownStudents(cs, index, f.division).map((st) => st.id), ...recBy.keys()]);
      for (const id of ids) {
        const st = byId.get(id);
        if (!st) continue;
        if (f.division && normalizeDivision(st.division) !== f.division) continue;
        const r = recBy.get(id) ?? null;
        const status = attendanceStatus(r);
        emit({
          sessionId: cs.id,
          date: dateOnly(cs.sessionDate)!,
          subject: cs.subject,
          teacher: cs.teacher.name,
          audience: formatAudience(cs.campus, cs.grade, cs.divisions, cs.allDivisions),
          studentId: st.id,
          externalId: st.externalId,
          name: st.name,
          rollNumber: st.rollNumber ?? '',
          gradeDivision: `${st.campus} · ${st.grade}-${st.division}`,
          status,
          statusLabel: STATUS_LABEL[status],
          firstJoined: hhmm(r?.firstJoinedAt, tz),
          admitted: hhmm(r?.admittedAt, tz),
          left: hhmm(r?.leftAt, tz),
          connectedMin: r ? Math.round(totalConnectedMs(r, cs.endedAt ?? now) / 60_000) : 0,
        });
      }
    }
  }
}

function sortDetail(rows: DetailRow[]): DetailRow[] {
  return rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.subject.localeCompare(b.subject) ||
      a.gradeDivision.localeCompare(b.gradeDivision) ||
      a.rollNumber.localeCompare(b.rollNumber, undefined, { numeric: true }) ||
      a.name.localeCompare(b.name)
  );
}

export async function attendanceDetail(f: ReportFilter): Promise<DetailRow[]> {
  const rows: DetailRow[] = [];
  await forEachDetailRow(f, (r) => rows.push(r));
  return sortDetail(rows);
}

/** Per-student summary straight from the detail stream (the detail rows are never all kept). */
export async function studentSummary(f: ReportFilter): Promise<StudentRow[]> {
  const acc = studentAccumulator();
  await forEachDetailRow(f, acc.add);
  return acc.result();
}

export function attendanceDetailCsv(rows: DetailRow[]) {
  return toCsv(
    ['Date', 'Subject', 'Teacher', 'Class', 'Student ID', 'Name', 'Roll no', 'Grade-division', 'Status', 'First joined', 'Admitted', 'Left', 'Connected (min)'],
    rows.map((r) => [r.date, r.subject, r.teacher, r.audience, r.externalId, r.name, r.rollNumber, r.gradeDivision, r.statusLabel, r.firstJoined, r.admitted, r.left, r.connectedMin])
  );
}

// ------------------------------------------------------------ per student

export type StudentRow = {
  studentId: string;
  externalId: string;
  name: string;
  rollNumber: string;
  gradeDivision: string;
  classes: number;
  present: number;
  late: number;
  notAdmitted: number;
  absent: number;
  attendancePct: number | null;
  connectedMin: number;
};

function studentAccumulator() {
  const m = new Map<string, StudentRow>();
  const add = (r: DetailRow) => {
    let s = m.get(r.studentId);
    if (!s) {
      s = {
        studentId: r.studentId,
        externalId: r.externalId,
        name: r.name,
        rollNumber: r.rollNumber,
        gradeDivision: r.gradeDivision,
        classes: 0,
        present: 0,
        late: 0,
        notAdmitted: 0,
        absent: 0,
        attendancePct: null,
        connectedMin: 0,
      };
      m.set(r.studentId, s);
    }
    s.classes++;
    s.connectedMin += r.connectedMin;
    if (r.status === 'present') s.present++;
    else if (r.status === 'late') s.late++;
    else if (r.status === 'not_admitted') s.notAdmitted++;
    else s.absent++;
  };
  const result = () => {
    for (const s of m.values()) s.attendancePct = s.classes ? Math.round(((s.present + s.late) / s.classes) * 1000) / 10 : null;
    return [...m.values()].sort(
      (a, b) =>
        a.gradeDivision.localeCompare(b.gradeDivision) ||
        a.rollNumber.localeCompare(b.rollNumber, undefined, { numeric: true }) ||
        a.name.localeCompare(b.name)
    );
  };
  return { add, result };
}

/** Aggregate detail rows per student. attendance % = (present + late) / classes held. */
export function summariseByStudent(rows: DetailRow[]): StudentRow[] {
  const acc = studentAccumulator();
  for (const r of rows) acc.add(r);
  return acc.result();
}

export function studentSummaryCsv(rows: StudentRow[]) {
  return toCsv(
    ['Student ID', 'Name', 'Roll no', 'Grade-division', 'Classes held', 'Present', 'Late', 'Waited not admitted', 'Absent', 'Attendance %', 'Connected (min)'],
    rows.map((r): Cell[] => [r.externalId, r.name, r.rollNumber, r.gradeDivision, r.classes, r.present, r.late, r.notAdmitted, r.absent, r.attendancePct, r.connectedMin])
  );
}
