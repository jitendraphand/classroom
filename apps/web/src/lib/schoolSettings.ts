import { prisma } from './db';
import { normalizeMicLimit } from './micSlots';
import { classCapacity } from './capacity';

export type SchoolSettings = {
  maxOpenStudentMics: number;
  maxStudentsPerClass: number | null;
};

const TTL_MS = 15_000;
let cache: { at: number; row: SchoolSettings } | null = null;

export function clearSchoolSettingsCache() {
  cache = null;
}

export async function getSchoolSettings(): Promise<SchoolSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.row;
  // A read on every refresh; the row is created once (an upsert here was a
  // write per worker every 15 s).
  const row =
    (await prisma.schoolSetting.findUnique({ where: { id: 'default' } })) ??
    (await prisma.schoolSetting.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } }));
  const next: SchoolSettings = {
    maxOpenStudentMics: normalizeMicLimit(row.maxOpenStudentMics),
    maxStudentsPerClass: classCapacity(row.maxStudentsPerClass),
  };
  cache = { at: Date.now(), row: next };
  return next;
}

export async function updateSchoolSettings(input: {
  maxOpenStudentMics?: number;
  maxStudentsPerClass?: number | null;
}): Promise<SchoolSettings> {
  const data: { maxOpenStudentMics?: number; maxStudentsPerClass?: number | null } = {};
  if (input.maxOpenStudentMics !== undefined) data.maxOpenStudentMics = normalizeMicLimit(input.maxOpenStudentMics);
  if (input.maxStudentsPerClass !== undefined) {
    data.maxStudentsPerClass = classCapacity(input.maxStudentsPerClass);
  }
  await prisma.schoolSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: { id: 'default', ...data },
  });
  clearSchoolSettingsCache();
  return getSchoolSettings();
}
