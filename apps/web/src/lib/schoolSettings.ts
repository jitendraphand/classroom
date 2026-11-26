import { prisma } from './db';
import { normalizeMicLimit } from './micSlots';

/**
 * School-wide settings. Classes have no size limit: the old optional
 * "students per class" cap was removed (its SchoolSetting.maxStudentsPerClass
 * column is no longer read or written).
 */
export type SchoolSettings = {
  maxOpenStudentMics: number;
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
  };
  cache = { at: Date.now(), row: next };
  return next;
}

export async function updateSchoolSettings(input: { maxOpenStudentMics?: number }): Promise<SchoolSettings> {
  const data: { maxOpenStudentMics?: number } = {};
  if (input.maxOpenStudentMics !== undefined) data.maxOpenStudentMics = normalizeMicLimit(input.maxOpenStudentMics);
  await prisma.schoolSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: { id: 'default', ...data },
  });
  clearSchoolSettingsCache();
  return getSchoolSettings();
}
