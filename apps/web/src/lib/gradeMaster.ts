/**
 * Prisma side of the Grade / Division master list (Admin → Grades & divisions).
 * Pure rules live in gradeMasterLogic.ts; request handling in gradeMasterApi.ts.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { normalizeDivision, normalizeGrade } from './grades';
import { audienceProblem, type MasterGrade, type Usage } from './gradeMasterLogic';
import type { GradeStore } from './gradeMasterApi';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function loadMaster(): Promise<MasterGrade[]> {
  const rows = await prisma.grade.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { divisions: { orderBy: { name: 'asc' } } },
  });
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    label: g.label,
    sortOrder: g.sortOrder,
    active: g.active,
    divisions: g.divisions.map((d) => ({ id: d.id, name: d.name, label: d.label, active: d.active })),
  }));
}

/**
 * Validation for new timetable slots, overrides, teacher assignments and
 * ad-hoc classes: returns an error message when the grade/divisions are not in
 * the master list (inactive entries still count, so editing an existing row
 * that uses a deactivated entry keeps working). Empty master list → null.
 */
export async function audienceUnknownMessage(grade: string, divisions: string[], allDivisions: boolean) {
  return audienceProblem(await loadMaster(), grade, divisions, allDivisions);
}

async function gradeUsage(grade: string): Promise<Usage> {
  const g = normalizeGrade(grade);
  const [assign, slotCount, slots, overrides, students, sessions] = await Promise.all([
    prisma.teacherAssignment.findMany({ where: { grade: g }, select: { division: true, teacher: { select: { name: true } } } }),
    prisma.timetableSlot.count({ where: { grade: g } }),
    prisma.timetableSlot.findMany({
      where: { grade: g },
      take: 3,
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      select: { weekday: true, startMinute: true, subject: true },
    }),
    prisma.scheduleOverride.count({ where: { grade: g } }),
    prisma.student.count({ where: { grade: g } }),
    prisma.classSession.count({ where: { grade: g } }),
  ]);
  return [
    {
      what: 'teacher assignment(s)',
      count: assign.length,
      examples: assign.map((a) => `${a.teacher.name} ${g}-${a.division === '*' ? 'ALL' : a.division}`),
    },
    {
      what: 'timetable slot(s)',
      count: slotCount,
      examples: slots.map((s) => `${WEEKDAYS[s.weekday]} ${hhmm(s.startMinute)} ${s.subject}`),
    },
    { what: 'timetable override(s)', count: overrides, examples: [] },
    { what: 'student(s)', count: students, examples: [] },
    { what: 'class session(s) in history', count: sessions, examples: [] },
  ];
}

async function divisionUsage(grade: string, division: string): Promise<Usage> {
  const g = normalizeGrade(grade);
  const d = normalizeDivision(division);
  const [assign, slotCount, slots, overrides, students, sessions] = await Promise.all([
    prisma.teacherAssignment.findMany({ where: { grade: g, division: d }, select: { teacher: { select: { name: true } } } }),
    prisma.timetableSlot.count({ where: { grade: g, divisions: { has: d } } }),
    prisma.timetableSlot.findMany({
      where: { grade: g, divisions: { has: d } },
      take: 3,
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      select: { weekday: true, startMinute: true, subject: true },
    }),
    prisma.scheduleOverride.count({ where: { grade: g, divisions: { has: d } } }),
    prisma.student.count({ where: { grade: g, division: { equals: d, mode: 'insensitive' } } }),
    prisma.classSession.count({ where: { grade: g, divisions: { has: d } } }),
  ]);
  return [
    { what: 'teacher assignment(s)', count: assign.length, examples: assign.map((a) => a.teacher.name) },
    {
      what: 'timetable slot(s)',
      count: slotCount,
      examples: slots.map((s) => `${WEEKDAYS[s.weekday]} ${hhmm(s.startMinute)} ${s.subject}`),
    },
    { what: 'timetable override(s)', count: overrides, examples: [] },
    { what: 'student(s)', count: students, examples: [] },
    { what: 'class session(s) in history', count: sessions, examples: [] },
  ];
}

async function usageCounts() {
  const gradeRows = await prisma.$queryRaw<{ g: string; n: number }[]>(Prisma.sql`
    SELECT g, SUM(n)::int AS n FROM (
      SELECT grade AS g, COUNT(*) AS n FROM "TeacherAssignment" GROUP BY 1
      UNION ALL SELECT grade, COUNT(*) FROM "TimetableSlot" GROUP BY 1
      UNION ALL SELECT grade, COUNT(*) FROM "ScheduleOverride" WHERE grade IS NOT NULL GROUP BY 1
      UNION ALL SELECT grade, COUNT(*) FROM "Student" GROUP BY 1
      UNION ALL SELECT grade, COUNT(*) FROM "ClassSession" GROUP BY 1
    ) x GROUP BY g`);
  const divRows = await prisma.$queryRaw<{ g: string; d: string; n: number }[]>(Prisma.sql`
    SELECT g, d, SUM(n)::int AS n FROM (
      SELECT grade AS g, division AS d, COUNT(*) AS n FROM "TeacherAssignment" GROUP BY 1, 2
      UNION ALL SELECT grade, upper(division), COUNT(*) FROM "Student" GROUP BY 1, 2
      UNION ALL SELECT s.grade, x.d, COUNT(*) FROM "TimetableSlot" s, unnest(s.divisions) AS x(d) GROUP BY 1, 2
      UNION ALL SELECT o.grade, x.d, COUNT(*) FROM "ScheduleOverride" o, unnest(o.divisions) AS x(d)
        WHERE o.grade IS NOT NULL GROUP BY 1, 2
      UNION ALL SELECT c.grade, x.d, COUNT(*) FROM "ClassSession" c, unnest(c.divisions) AS x(d) GROUP BY 1, 2
    ) y GROUP BY g, d`);
  const grades: Record<string, number> = {};
  const divisions: Record<string, number> = {};
  for (const r of gradeRows) {
    const k = normalizeGrade(r.g);
    grades[k] = (grades[k] ?? 0) + Number(r.n);
  }
  for (const r of divRows) {
    const k = `${normalizeGrade(r.g)}|${normalizeDivision(r.d)}`;
    divisions[k] = (divisions[k] ?? 0) + Number(r.n);
  }
  return { grades, divisions };
}

async function sources() {
  const [assign, slots, overrides, students, sessions] = await Promise.all([
    prisma.teacherAssignment.findMany({ select: { grade: true, division: true }, distinct: ['grade', 'division'] }),
    prisma.timetableSlot.findMany({ select: { grade: true, divisions: true } }),
    prisma.scheduleOverride.findMany({ where: { grade: { not: null } }, select: { grade: true, divisions: true } }),
    prisma.student.findMany({ select: { grade: true, division: true }, distinct: ['grade', 'division'] }),
    prisma.$queryRaw<{ grade: string; divisions: string[] }[]>(Prisma.sql`
      SELECT grade, array_agg(DISTINCT x.d) FILTER (WHERE x.d IS NOT NULL) AS divisions
      FROM "ClassSession" c LEFT JOIN LATERAL unnest(c.divisions) AS x(d) ON true GROUP BY grade`),
  ]);
  return [
    ...assign.map((a) => ({ grade: a.grade, divisions: [a.division] })),
    ...slots,
    ...overrides,
    ...students.map((s) => ({ grade: s.grade, divisions: [s.division] })),
    ...sessions.map((s) => ({ grade: s.grade, divisions: s.divisions ?? [] })),
  ];
}

const toGrade = (g: { id: string; name: string; label: string; sortOrder: number; active: boolean }) => ({
  id: g.id,
  name: g.name,
  label: g.label,
  sortOrder: g.sortOrder,
  active: g.active,
});

export const gradeStore: GradeStore = {
  list: loadMaster,
  usageCounts,
  gradeUsage,
  divisionUsage,
  async getGrade(id) {
    const g = await prisma.grade.findUnique({ where: { id } });
    return g ? toGrade(g) : null;
  },
  async getDivision(id) {
    const d = await prisma.division.findUnique({ where: { id }, include: { grade: { select: { name: true } } } });
    return d ? { id: d.id, gradeId: d.gradeId, gradeName: d.grade.name, name: d.name, label: d.label, active: d.active } : null;
  },
  async createGrade(d) {
    return toGrade(await prisma.grade.create({ data: d }));
  },
  async updateGrade(id, d) {
    await prisma.grade.update({ where: { id }, data: d });
  },
  async deleteGrade(id) {
    await prisma.grade.delete({ where: { id } });
  },
  async createDivision(gradeId, d) {
    const row = await prisma.division.create({ data: { gradeId, ...d }, include: { grade: { select: { name: true } } } });
    return { id: row.id, gradeId, gradeName: row.grade.name, name: row.name, label: row.label, active: row.active };
  },
  async updateDivision(id, d) {
    await prisma.division.update({ where: { id }, data: d });
  },
  async deleteDivision(id) {
    await prisma.division.delete({ where: { id } });
  },
  async reorder(ids) {
    await prisma.$transaction(ids.map((id, i) => prisma.grade.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })));
  },
  sources,
  async studentGroups() {
    const rows = await prisma.student.groupBy({ by: ['grade', 'division'], _count: { _all: true } });
    return rows.map((r) => ({ grade: r.grade, division: r.division, count: r._count._all }));
  },
};
