import { prisma } from './db';
import { academicYearForDate, academicYearProblem, isAcademicYearLabel } from './academicYear';
import { appTimeZone } from './schoolConfig';
import { localDateOf } from './schedule';

export async function ensureCurrentAcademicYear(now = new Date()): Promise<string> {
  const label = academicYearForDate(localDateOf(now, appTimeZone()));
  if (!isAcademicYearLabel(label)) return label;
  await prisma.academicYear.upsert({
    where: { label },
    update: {},
    create: { label, active: true },
  });
  return label;
}

export async function listAcademicYears() {
  await ensureCurrentAcademicYear();
  return prisma.academicYear.findMany({ orderBy: { label: 'desc' } });
}

export async function createAcademicYear(label: unknown) {
  const problem = academicYearProblem(label);
  if (problem) throw new Error(problem);
  const value = String(label).trim();
  return prisma.academicYear.upsert({
    where: { label: value },
    update: { active: true },
    create: { label: value, active: true },
  });
}

export async function setAcademicYearActive(id: string, active: boolean) {
  const row = await prisma.academicYear.findUnique({ where: { id } });
  if (!row) return null;
  return prisma.academicYear.update({ where: { id }, data: { active } });
}

/** Delete a label nobody has scheduled or taught under. */
export async function deleteAcademicYear(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await prisma.academicYear.findUnique({ where: { id } });
  if (!row) return { ok: false, error: 'Academic year not found' };
  const [slots, sessions] = await Promise.all([
    prisma.timetableSlot.count({ where: { academicYear: row.label } }),
    prisma.classSession.count({ where: { academicYear: row.label } }),
  ]);
  if (slots || sessions) return { ok: false, error: 'That year is used by classes. Deactivate it instead.' };
  await prisma.academicYear.delete({ where: { id } });
  return { ok: true };
}
