/**
 * Large classes: the roster and the waiting list render a window of rows
 * (the most important first: sortRoster puts raised hands, draw requests and
 * speakers on top), with "Show more" and search for the rest. A class of
 * 2,500 then costs the teacher's browser 150 rows, not 2,500 rows of buttons.
 * Pure, unit-tested; the Windows app uses the same rule.
 */
export const ROSTER_PAGE = 150;

export function rosterWindow<T>(rows: T[], limit: number): { shown: T[]; hidden: number; next: number } {
  const n = Math.max(ROSTER_PAGE, Math.floor(limit) || ROSTER_PAGE);
  const shown = rows.length > n ? rows.slice(0, n) : rows;
  const hidden = rows.length - shown.length;
  return { shown, hidden, next: Math.min(hidden, ROSTER_PAGE) };
}
