/**
 * Student-facing salutation for a teacher, from the admin-set gender.
 * Male → Sir / Sir's; Female → Ma'am / Ma'am's; unset → the name only.
 * Pure, unit-tested.
 */

export type TeacherGender = 'male' | 'female';

export function parseTeacherGender(raw: unknown): TeacherGender | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'male' || s === 'm') return 'male';
  if (s === 'female' || s === 'f') return 'female';
  return null;
}

export function genderLabel(gender: string | null | undefined): string | null {
  const g = parseTeacherGender(gender);
  if (g === 'male') return 'Male';
  if (g === 'female') return 'Female';
  return null;
}

/**
 * "Jitendra Phand Sir" / "Jitendra Phand Sir's" / "Priya Sharma Ma'am's".
 * If gender is not set, the name is returned unchanged (we do not guess).
 */
export function formatTeacherName(
  name: string,
  gender: string | null | undefined,
  style: 'plain' | 'possessive' = 'plain',
): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) return '';
  const g = parseTeacherGender(gender);
  if (g === 'male') return style === 'possessive' ? `${n} Sir's` : `${n} Sir`;
  if (g === 'female') return style === 'possessive' ? `${n} Ma'am's` : `${n} Ma'am`;
  return n;
}
