import { prisma } from './db';
import { academicYearForDate, isAcademicYearLabel } from './academicYear';
import { listAcademicYears } from './academicYears';
import { classTone, TONE_LABEL, type ClassTone } from './capacity';
import { averageStars, presentStars } from './feedbackText';
import { formatAudience } from './grades';
import { latestRank, ensureWeeklySnapshots } from './rankingService';
import { formatHHMM, isLocalDate, localDateOf, localMinuteOf } from './schedule';
import { occurrencesForRange } from './scheduleService';
import { attendanceRatio, averageAttendance, enrolledStudents } from './sessionStats';
import { appTimeZone } from './schoolConfig';

function monthOf(raw: string | null, today: string) {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return today.slice(0, 7);
}

function monthDays(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number);
  const n = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= n; d++) out.push(`${ym}-${String(d).padStart(2, '0')}`);
  return out;
}

function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

type SessionRow = {
  id: string;
  occurrenceKey: string | null;
  teacherId: string;
  campus: string;
  grade: string;
  divisions: string[];
  allDivisions: boolean;
  subject: string;
  sessionDate: Date;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  adHoc: boolean;
  academicYear: string;
  attendance: { studentId: string; admittedAt: Date | null }[];
};

function dateKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function buildTeacherHome(teacherId: string, url: URL) {
  const tz = appTimeZone();
  const now = new Date();
  const today = localDateOf(now, tz);
  const nowMinute = localMinuteOf(now, tz);
  const years = await listAcademicYears();
  const requested = url.searchParams.get('year');
  const year = isAcademicYearLabel(requested || '') ? String(requested) : academicYearForDate(today);
  await ensureWeeklySnapshots().catch((e) => console.error('[rank]', e));

  const month = monthOf(url.searchParams.get('month'), today);
  const days = monthDays(month);
  const monthFrom = days[0]!;
  const monthTo = days[days.length - 1]!;

  const [occs, sessions, rank] = await Promise.all([
    occurrencesForRange(monthFrom, monthTo, tz, year).then((rows) => rows.filter((o) => o.teacherId === teacherId)),
    prisma.classSession.findMany({
      where: { teacherId, academicYear: year },
      include: { attendance: { select: { studentId: true, admittedAt: true } } },
    }),
    latestRank(teacherId, year),
  ]);

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
    list.push({ studentId: f.studentId, stars: f.stars });
    starsBySession.set(f.classSessionId, list);
  }

  const byKey = new Map(sessions.filter((s) => s.occurrenceKey).map((s) => [s.occurrenceKey!, s]));

  function starsOf(cs: SessionRow) {
    const present = new Set(cs.attendance.filter((a) => a.admittedAt).map((a) => a.studentId));
    return averageStars(presentStars(starsBySession.get(cs.id) ?? [], present));
  }

  function counts(cs: SessionRow) {
    const present = cs.attendance.filter((a) => a.admittedAt).length;
    const enrolled = enrolledStudents(cs, pupils).length;
    return { present, enrolled, ratio: attendanceRatio(present, enrolled) };
  }

  const conducted = sessions.filter((s) => s.startedAt);
  const allPresentStars: number[] = [];
  for (const cs of conducted) {
    const present = new Set(cs.attendance.filter((a) => a.admittedAt).map((a) => a.studentId));
    allPresentStars.push(...presentStars(starsBySession.get(cs.id) ?? [], present));
  }

  const calendarDays = days.map((date) => {
    const items = occs
      .filter((o) => o.date === date)
      .map((o) => {
        const cs = byKey.get(o.key) ?? null;
        const tone = classTone({
          date,
          today,
          nowMinute,
          startMinute: o.startMinute,
          endMinute: o.endMinute,
          started: !!cs?.startedAt,
          ended: !!cs?.endedAt,
        });
        return { key: o.key, subject: o.subject, tone, start: formatHHMM(o.startMinute) };
      });
    for (const cs of sessions) {
      if (!cs.adHoc || dateKey(cs.sessionDate) !== date) continue;
      const tone = classTone({
        date,
        today,
        nowMinute,
        startMinute: 0,
        endMinute: 24 * 60,
        started: !!cs.startedAt,
        ended: !!cs.endedAt,
      });
      items.push({ key: cs.id, subject: cs.subject, tone, start: 'Ad hoc' });
    }
    return { date, items };
  });

  const from = isLocalDate(url.searchParams.get('from') || '') ? url.searchParams.get('from')! : monthFrom;
  const to = isLocalDate(url.searchParams.get('to') || '') ? url.searchParams.get('to')! : monthTo;
  const grade = (url.searchParams.get('grade') || '').trim();
  const division = (url.searchParams.get('division') || '').trim();
  const subject = (url.searchParams.get('subject') || '').trim().toLowerCase();
  const status = (url.searchParams.get('status') || '').trim();

  type TableRow = {
    id: string | null;
    date: string;
    subject: string;
    audience: string;
    grade: string;
    divisions: string[];
    allDivisions: boolean;
    attendance: string;
    present: number;
    enrolled: number;
    avgStars: number | null;
    tone: ClassTone;
    adHoc: boolean;
  };

  const table: TableRow[] = [];
  const seen = new Set<string>();
  for (const cs of sessions) {
    const date = dateKey(cs.sessionDate);
    if (date < from || date > to) continue;
    const c = counts(cs);
    const tone = classTone({
      date,
      today,
      nowMinute,
      startMinute: cs.scheduledStart ? localMinuteOf(cs.scheduledStart, tz) : 0,
      endMinute: cs.scheduledEnd ? localMinuteOf(cs.scheduledEnd, tz) : 24 * 60,
      started: !!cs.startedAt,
      ended: !!cs.endedAt,
    });
    if (cs.occurrenceKey) seen.add(cs.occurrenceKey);
    table.push({
      id: cs.id,
      date,
      subject: cs.subject,
      audience: formatAudience(cs.campus, cs.grade, cs.divisions, cs.allDivisions),
      grade: cs.grade,
      divisions: cs.divisions,
      allDivisions: cs.allDivisions,
      attendance: `${c.present}/${c.enrolled}`,
      present: c.present,
      enrolled: c.enrolled,
      avgStars: starsOf(cs),
      tone,
      adHoc: cs.adHoc,
    });
  }
  for (const o of await occurrencesForRange(from, to, tz, year)) {
    if (o.teacherId !== teacherId || seen.has(o.key)) continue;
    const date = o.date;
    const tone = classTone({
      date,
      today,
      nowMinute,
      startMinute: o.startMinute,
      endMinute: o.endMinute,
      started: false,
      ended: false,
    });
    table.push({
      id: null,
      date,
      subject: o.subject,
      audience: formatAudience(o.campus, o.grade, o.divisions, o.allDivisions),
      grade: o.grade,
      divisions: o.divisions,
      allDivisions: o.allDivisions,
      attendance: '—',
      present: 0,
      enrolled: 0,
      avgStars: null,
      tone,
      adHoc: false,
    });
  }

  const filtered = table
    .filter((row) => !grade || row.grade === grade)
    .filter((row) => !division || row.allDivisions || row.divisions.includes(division))
    .filter((row) => !subject || row.subject.toLowerCase().includes(subject))
    .filter((row) => !status || status === 'all' || row.tone === status)
    .sort((a, b) => b.date.localeCompare(a.date) || a.subject.localeCompare(b.subject));

  return {
    year,
    years: years.map((y) => ({ label: y.label, active: y.active })),
    timezone: tz,
    today,
    month,
    prevMonth: shiftMonth(month, -1),
    nextMonth: shiftMonth(month, 1),
    legend: TONE_LABEL,
    kpis: {
      sessionsConducted: conducted.length,
      averageAttendance: averageAttendance(conducted.map((cs) => counts(cs).ratio)),
      averageRating: averageStars(allPresentStars),
      rank: rank
        ? {
            percentile: rank.percentile,
            weekStart: dateKey(rank.weekStart),
            eligible: rank.eligible,
            ratingCount: rank.ratingCount,
            bayesianAvg: Math.round(rank.bayesianAvg * 10) / 10,
          }
        : null,
    },
    calendar: calendarDays,
    sessions: filtered,
  };
}
