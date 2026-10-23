/**
 * Academic year labels, e.g. "2026-27". The default calendar is India's
 * 1 June–31 May, but the first month is configurable with
 * ACADEMIC_YEAR_START_MONTH (server) / NEXT_PUBLIC_ACADEMIC_YEAR_START_MONTH
 * (browser), 1–12. With June: June 2026 → "2026-27", May 2026 → "2025-26".
 * The label is always the admin's choice when scheduling; this is only the
 * default derived from a calendar date. Nothing validates a class's dates
 * against the label, so a school with a different calendar just picks it.
 */

const LABEL_RE = /^(\d{4})-(\d{2})$/;

export const DEFAULT_ACADEMIC_YEAR_START_MONTH = 6;

/** First month (1–12) of the academic year. Env override, else June. */
export function academicYearStartMonth(): number {
  const raw =
    typeof process !== 'undefined'
      ? process.env.ACADEMIC_YEAR_START_MONTH || process.env.NEXT_PUBLIC_ACADEMIC_YEAR_START_MONTH
      : undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_ACADEMIC_YEAR_START_MONTH;
}

export function academicYearForDate(date: string, startMonth = academicYearStartMonth()): string {
  const [ys, ms] = date.slice(0, 10).split('-');
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return '';
  const first = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : DEFAULT_ACADEMIC_YEAR_START_MONTH;
  // A January start means the year is one calendar year; still labelled "2026-27" style.
  const start = m >= first ? y : y - 1;
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
  if (!isAcademicYearLabel(s.trim())) return 'Use a year like 2026-27.';
  return null;
}

/**
 * Dropdown choices for scheduling: the school's labels plus the previous,
 * current and next year, newest first. `current` is the default selection.
 */
export function academicYearChoices(labels: readonly string[], current: string): string[] {
  const set = new Set(labels.filter(isAcademicYearLabel));
  const m = LABEL_RE.exec(current);
  if (m) {
    const start = Number(m[1]);
    for (const d of [-1, 0, 1]) set.add(formatAcademicYear(start + d));
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}
