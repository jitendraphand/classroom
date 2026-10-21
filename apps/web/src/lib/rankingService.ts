import { prisma } from './db';
import { academicYearForDate } from './academicYear';
import { rankTeachers, weekStartMonday, type RankRow } from './ranking';
import { appTimeZone } from './schoolConfig';
import { addDays, dateValue, localDateOf, weekdayOf } from './schedule';

export async function computeRankWeek(academicYear: string, weekStart: string): Promise<RankRow[]> {
  const teachers = await prisma.teacher.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  const sessions = await prisma.classSession.findMany({
    where: { academicYear, teacherId: { in: teachers.map((t) => t.id) } },
    select: {
      id: true,
      teacherId: true,
      attendance: { where: { admittedAt: { not: null } }, select: { studentId: true } },
      feedback: { select: { studentId: true, stars: true } },
    },
  });
  const byTeacher = new Map<string, number[]>();
  for (const t of teachers) byTeacher.set(t.id, []);
  for (const cs of sessions) {
    const present = new Set(cs.attendance.map((a) => a.studentId));
    const bucket = byTeacher.get(cs.teacherId);
    if (!bucket) continue;
    for (const f of cs.feedback) {
      if (present.has(f.studentId)) bucket.push(f.stars);
    }
  }
  const rows = rankTeachers([...byTeacher.entries()].map(([id, ratings]) => ({ id, ratings })));
  if (!rows.length) return rows;
  const week = dateValue(weekStart);
  await prisma.$transaction(
    rows.map((row) =>
      prisma.teacherRankSnapshot.upsert({
        where: { teacherId_academicYear_weekStart: { teacherId: row.id, academicYear, weekStart: week } },
        create: {
          teacherId: row.id,
          academicYear,
          weekStart: week,
          percentile: row.percentile,
          bayesianAvg: row.bayesianAvg,
          rawAvg: row.rawAvg,
          ratingCount: row.ratingCount,
          eligible: row.eligible,
        },
        update: {
          percentile: row.percentile,
          bayesianAvg: row.bayesianAvg,
          rawAvg: row.rawAvg,
          ratingCount: row.ratingCount,
          eligible: row.eligible,
          computedAt: new Date(),
        },
      })
    )
  );
  return rows;
}

/** Write the current week's snapshot when it is missing, and the previous week once. */
export async function ensureWeeklySnapshots(now = new Date()): Promise<void> {
  const tz = appTimeZone();
  const today = localDateOf(now, tz);
  const week = weekStartMonday(today, weekdayOf(today));
  const year = academicYearForDate(today);
  if (!year) return;
  const have = await prisma.teacherRankSnapshot.findFirst({
    where: { academicYear: year, weekStart: dateValue(week) },
    select: { id: true },
  });
  if (!have) await computeRankWeek(year, week);
  const prev = addDays(week, -7);
  const prevYear = academicYearForDate(prev);
  if (!prevYear) return;
  const prevHave = await prisma.teacherRankSnapshot.findFirst({
    where: { academicYear: prevYear, weekStart: dateValue(prev) },
    select: { id: true },
  });
  if (!prevHave) await computeRankWeek(prevYear, prev);
}

export async function latestRank(teacherId: string, academicYear: string) {
  return prisma.teacherRankSnapshot.findFirst({
    where: { teacherId, academicYear },
    orderBy: { weekStart: 'desc' },
  });
}
