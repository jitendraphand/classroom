/**
 * Academic year labels, India school calendar: 1 June–31 May.
 * June 2026 → "2026-27". May 2026 → "2025-26". The label is editable;
 * this is only the default derived from a calendar date.
 */

const LABEL_RE = /^(\d{4})-(\d{2})$/;

export function academicYearForDate(date: string): string {
  const [ys, ms] = date.slice(0, 10).split('-');
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return '';
  const start = m >= 6 ? y : y - 1;
  return formatAcademicYear(start);
}

export function formatAcademicYear(startYear: number): string {
  const end = (startYear + 1) % 100;
  return `${startYear}-${String(end).padStart(2, '0')}`;
}

/** "2026-27" is valid. "2026-28" and "26-27" are not. */
export function isAcademicYearLabel(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = LABEL_RE.exec(s);
  if (!m) return false;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end === (start + 1) % 100;
}

export function academicYearProblem(s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return 'Choose an academic year (for example 2026-27).';
  if (!isAcademicYearLabel(s.trim())) return 'Use a year like 2026-27 (June–May).';
  return null;
}
