import { prisma } from './db';
import { academicYearForDate, isAcademicYearLabel } from './academicYear';
import { listAcademicYears } from './academicYears';
import { todayTag, type TodayTag } from './capacity';
import { averageStars, presentStars } from './feedbackText';
import { formatAudience } from './grades';
import { formatHHMM, localDateOf, localMinuteOf } from './schedule';
import { occurrencesForDate } from './scheduleService';
import { attendanceRatio, averageAttendance, enrolledStudents } from './sessionStats';
import { appTimeZone } from './schoolConfig';
import { latestRank } from './rankingService';

function dateKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function adminToday(url: URL) {
  const tz = appTimeZone();
  const now = new Date();
  const today = localDateOf(now, tz);
  const nowMinute = localMinuteOf(now, tz);
  const years = await listAcademicYears();
  const requested = url.searchParams.get('year');
  const year = isAcademicYearLabel(requested || '') ? String(requested) : academicYearForDate(today);
  const occs = (await occurrencesForDate(today, tz)).filter((o) => !year || !o.academicYear || o.academicYear === year);
  const keys = occs.map((o) => o.key);
  const sessions = keys.length
    ? await prisma.classSession.findMany({
        where: { occurrenceKey: { in: keys } },
        select: { id: true, occurrenceKey: true, startedAt: true, endedAt: true, roomId: true },
      })
    : [];
  const byKey = new Map(sessions.map((s) => [s.occurrenceKey, s]));
  const sessionIds = sessions.map((s) => s.id);
  const rooms = sessionIds.length
    ? await prisma.room.findMany({
        where: { classSessionId: { in: sessionIds }, status: { in: ['LIVE', 'WAITING'] } },
        select: { code: true, status: true, classSessionId: true },
      })
    : [];
  const roomBySession = new Map(rooms.map((r) => [r.classSessionId, r]));
  const teacherIds = [...new Set(occs.map((o) => o.teacherId))];
  const names = new Map(
    (await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name])
  );

  const classes = occs.map((o) => {
    const cs = o.key ? byKey.get(o.key) : undefined;
    const room = cs ? roomBySession.get(cs.id) : undefined;
    const started = !!cs?.startedAt;
    const ended = !!cs?.endedAt;
    const live = !!room && !ended && started;
    const tag: TodayTag = todayTag({
      nowMinute,
      startMinute: o.startMinute,
      started,
      ended,
      live,
    });
    return {
      key: o.key,
      subject: o.subject,
      audience: formatAudience(o.campus, o.grade, o.divisions, o.allDivisions),
      teacherId: o.teacherId,
      teacherName: names.get(o.teacherId) ?? 'Teacher',
      start: formatHHMM(o.startMinute),
      end: formatHHMM(o.endMinute),
      tag,
      roomCode: room?.code ?? null,
      sessionId: cs?.id ?? null,
    };
  });

  return { today, year, years: years.map((y) => y.label), timezone: tz, classes };
}

export async function adminPerformance(url: URL) {
  const tz = appTimeZone();
  const today = localDateOf(new Date(), tz);
  const years = await listAcademicYears();
  const requested = url.searchParams.get('year');
  const year = isAcademicYearLabel(requested || '') ? String(requested) : academicYearForDate(today);
  const teacherId = url.searchParams.get('teacherId') || undefined;
  const teachers = await prisma.teacher.findMany({
    where: { deletedAt: null, ...(teacherId ? { id: teacherId } : {}) },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
  const sessions = await prisma.classSession.findMany({
    where: { academicYear: year, teacherId: { in: teachers.map((t) => t.id) }, startedAt: { not: null } },
    include: { attendance: { select: { studentId: true, admittedAt: true } } },
  });
  const feedback = sessions.length
    ? await prisma.classFeedback.findMany({
        where: { classSessionId: { in: sessions.map((s) => s.id) } },
        select: { classSessionId: true, studentId: true, stars: true },
      })
    : [];
  const grades = [...new Set(sessions.map((s) => s.grade))];
  const pupils = grades.length
    ? await prisma.student.findMany({
        where: { grade: { in: grades } },
        select: { id: true, campus: true, grade: true, division: true, createdAt: true, deletedAt: true },
      })
    : [];
  const starsBySession = new Map<string, { studentId: string; stars: number }[]>();
  for (const f of feedback) {
    const list = starsBySession.get(f.classSessionId) ?? [];
    list.push(f);
    starsBySession.set(f.classSessionId, list);
  }

  const rows = [];
  for (const t of teachers) {
    const mine = sessions.filter((s) => s.teacherId === t.id);
    const ratios = mine.map((cs) => {
      const present = cs.attendance.filter((a) => a.admittedAt).length;
      return attendanceRatio(present, enrolledStudents(cs, pupils).length);
    });
    const ratings: number[] = [];
    for (const cs of mine) {
      const present = new Set(cs.attendance.filter((a) => a.admittedAt).map((a) => a.studentId));
      ratings.push(...presentStars(starsBySession.get(cs.id) ?? [], present));
    }
    const rank = await latestRank(t.id, year);
    rows.push({
      teacherId: t.id,
      name: t.name,
      email: t.email,
      classes: mine.length,
      averageAttendance: averageAttendance(ratios),
      averageStars: averageStars(ratings),
      rank: rank
        ? { percentile: rank.percentile, weekStart: dateKey(rank.weekStart), eligible: rank.eligible, ratingCount: rank.ratingCount }
        : null,
    });
  }
  return { year, years: years.map((y) => y.label), teachers: rows };
}

export async function adminTeacherSessions(teacherId: string, year: string) {
  const sessions = await prisma.classSession.findMany({
    where: { teacherId, academicYear: year, startedAt: { not: null } },
    orderBy: { sessionDate: 'desc' },
    select: {
      id: true,
      subject: true,
      campus: true,
      grade: true,
      divisions: true,
      allDivisions: true,
      sessionDate: true,
      startedAt: true,
      endedAt: true,
    },
  });
  return sessions.map((s) => ({
    id: s.id,
    subject: s.subject,
    audience: formatAudience(s.campus, s.grade, s.divisions, s.allDivisions),
    date: dateKey(s.sessionDate),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  }));
}

/** Admin-only: stars and the written text. Never call this for a teacher. */
export async function adminSessionFeedback(sessionId: string) {
  const rows = await prisma.classFeedback.findMany({
    where: { classSessionId: sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      stars: true,
      comment: true,
      createdAt: true,
      student: { select: { name: true, rollNumber: true } },
    },
  });
  return rows.map((r) => ({
    studentName: r.student.name,
    rollNumber: r.student.rollNumber,
    stars: r.stars,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
  }));
}
