/**
 * Admin → teacher assignments "add" row (Nov 25): any combination of campuses
 * × one grade × any combination of divisions (or all divisions) in one click.
 * Pure, unit-tested.
 */
import { ALL_DIVISIONS, normalizeCampus, normalizeDivision, normalizeGrade, type Assignment } from './grades';

export function addAssignments(
  items: readonly Assignment[],
  campuses: readonly string[],
  grade: string,
  pick: { all: boolean; divisions: readonly string[] }
): Assignment[] {
  const g = normalizeGrade(grade);
  const cs = [...new Set(campuses.map(normalizeCampus).filter(Boolean))];
  const ds = pick.all ? [ALL_DIVISIONS] : [...new Set(pick.divisions.map(normalizeDivision).filter(Boolean))];
  if (!g || !cs.length || !ds.length) return [...items];
  let out = [...items];
  for (const c of cs) {
    for (const d of ds) {
      // "All divisions" replaces that campus-grade's single divisions; an
      // existing identical row is not duplicated.
      out = out.filter((a) => !(a.campus === c && a.grade === g && (a.division === d || d === ALL_DIVISIONS)));
      out.push({ campus: c, grade: g, division: d });
    }
  }
  return out;
}
