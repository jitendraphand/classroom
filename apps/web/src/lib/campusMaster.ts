/**
 * Prisma side of the campus master list (Admin → Grades & divisions → Campuses).
 * Pure rules: lib/campusLogic.ts.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { normalizeCampus } from './grades';
import { campusProblem, missingCampuses, type MasterCampus } from './campusLogic';
import type { Usage } from './gradeMasterLogic';

export async function loadCampuses(): Promise<MasterCampus[]> {
  const rows = await prisma.campus.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  return rows.map((c) => ({ id: c.id, name: c.name, label: c.label, sortOrder: c.sortOrder, active: c.active }));
}

/** The only active campus ('' when there are none or several). */
export async function soleCampus(): Promise<string> {
  const active = (await loadCampuses()).filter((c) => c.active);
  return active.length === 1 ? active[0]!.name : '';
}

/** Validation for new slots / overrides / assignments / ad-hoc classes. */
export async function campusUnknownMessage(campus: string): Promise<string | null> {
  return campusProblem(await loadCampuses(), campus);
}

export async function campusUsage(campus: string): Promise<Usage> {
  const c = normalizeCampus(campus);
  const [assign, slots, overrides, students, sessions] = await Promise.all([
    prisma.teacherAssignment.count({ where: { campus: c, teacher: { deletedAt: null } } }),
    prisma.timetableSlot.count({ where: { campus: c } }),
    prisma.scheduleOverride.count({ where: { campus: c } }),
    prisma.student.count({ where: { campus: c, deletedAt: null } }),
    prisma.classSession.count({ where: { campus: c } }),
  ]);
  return [
    { what: 'teacher assignment(s)', count: assign, examples: [] },
    { what: 'timetable slot(s)', count: slots, examples: [] },
    { what: 'timetable override(s)', count: overrides, examples: [] },
    { what: 'student(s)', count: students, examples: [] },
    { what: 'class session(s) in history', count: sessions, examples: [] },
  ];
}

export async function campusUsageCounts(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ c: string; n: number }[]>(Prisma.sql`
    SELECT c, SUM(n)::int AS n FROM (
      SELECT a.campus AS c, COUNT(*) AS n FROM "TeacherAssignment" a
        JOIN "Teacher" t ON t.id = a."teacherId" WHERE t."deletedAt" IS NULL GROUP BY 1
      UNION ALL SELECT campus, COUNT(*) FROM "TimetableSlot" GROUP BY 1
      UNION ALL SELECT campus, COUNT(*) FROM "ScheduleOverride" WHERE campus IS NOT NULL GROUP BY 1
      UNION ALL SELECT campus, COUNT(*) FROM "Student" WHERE "deletedAt" IS NULL GROUP BY 1
      UNION ALL SELECT campus, COUNT(*) FROM "ClassSession" GROUP BY 1
    ) x GROUP BY c`);
  const out: Record<string, number> = {};
  for (const r of rows) out[normalizeCampus(r.c)] = (out[normalizeCampus(r.c)] ?? 0) + Number(r.n);
  return out;
}

/** "Sync from existing data": add campuses used by rows but missing from the list. */
export async function syncCampusesFromData(): Promise<number> {
  const [master, a, s, o, st, cs] = await Promise.all([
    loadCampuses(),
    prisma.teacherAssignment.findMany({ select: { campus: true }, distinct: ['campus'] }),
    prisma.timetableSlot.findMany({ select: { campus: true }, distinct: ['campus'] }),
    prisma.scheduleOverride.findMany({ where: { campus: { not: null } }, select: { campus: true }, distinct: ['campus'] }),
    prisma.student.findMany({ where: { deletedAt: null }, select: { campus: true }, distinct: ['campus'] }),
    prisma.classSession.findMany({ select: { campus: true }, distinct: ['campus'] }),
  ]);
  const missing = missingCampuses([...a, ...s, ...o, ...st, ...cs].map((r) => r.campus), master);
  let sortOrder = master.reduce((m, x) => Math.max(m, x.sortOrder), 0);
  for (const name of missing) {
    sortOrder += 10;
    await prisma.campus.create({ data: { name, label: name, sortOrder } });
  }
  return missing.length;
}

/** Student campuses seen from the school app that the list lacks. */
export async function unrecognisedCampuses() {
  const [master, groups] = await Promise.all([
    loadCampuses(),
    prisma.student.groupBy({ by: ['campus'], where: { deletedAt: null }, _count: { _all: true } }),
  ]);
  const have = new Set(master.map((c) => c.name));
  return groups
    .filter((g) => !have.has(g.campus))
    .map((g) => ({ campus: g.campus, count: g._count._all }))
    .sort((x, y) => x.campus.localeCompare(y.campus));
}

export const campusStore: import('./campusApi').CampusStore = {
  list: loadCampuses,
  usageCounts: campusUsageCounts,
  usage: campusUsage,
  async create(d) {
    const c = await prisma.campus.create({ data: d });
    return { id: c.id, name: c.name, label: c.label, sortOrder: c.sortOrder, active: c.active };
  },
  async update(id, d) {
    await prisma.campus.update({ where: { id }, data: d });
  },
  async remove(id) {
    await prisma.campus.delete({ where: { id } });
  },
  unrecognised: unrecognisedCampuses,
};
