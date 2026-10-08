/**
 * Pure campus rules (no Prisma), unit-tested in tests/campus.test.ts.
 *
 * Campus is the third audience criterion next to grade and division. Rows
 * store the canonical name (normalizeCampus: upper-case, no spaces) as a
 * plain string, like grades and divisions; the Campus table (Admin → Grades &
 * divisions → Campuses) feeds dropdowns and validation.
 */
import { normalizeCampus } from './grades';

export type MasterCampus = { id: string; name: string; label: string; sortOrder: number; active: boolean };
export type CampusOption = { name: string; label: string };

/** Clean an admin-typed campus into canonical name + display label. */
export function campusInput(raw: unknown): { name: string; label: string } | null {
  const label = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const name = normalizeCampus(label);
  if (!name || name === 'ALL' || !/^[\p{L}\p{N}.:-]+$/u.test(name)) return null;
  return { name, label };
}

/** Dropdown data: active campuses in order. */
export function activeCampusOptions(master: MasterCampus[]): CampusOption[] {
  return [...master]
    .filter((c) => c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, label: c.label }));
}

/**
 * Campus for a school-app join.
 * - The link names a campus → that campus (normalised; an unknown campus is
 *   still saved, like an unknown grade, and flagged to the admin).
 * - No campus in the link → the school's only active campus. With several
 *   (or no) campuses the join is refused (`null`) with a clear message: we
 *   cannot guess which campus the student belongs to.
 */
export function resolveJoinCampus(linkCampus: string | null | undefined, master: MasterCampus[]): string | null {
  const c = normalizeCampus(linkCampus ?? '');
  if (c) return c;
  const active = master.filter((x) => x.active);
  return active.length === 1 ? active[0]!.name : null;
}

/** Is this campus known (active or not)? Empty master: anything is accepted. */
export function campusProblem(master: Pick<MasterCampus, 'name'>[], campus: string): string | null {
  const c = normalizeCampus(campus);
  if (!c) return 'Pick a campus.';
  if (!master.length) return null;
  if (!master.some((x) => x.name === c)) return `Campus ${c} is not in Grades & divisions. Add it there first.`;
  return null;
}

/** Campuses referenced by existing rows but missing from the master list. */
export function missingCampuses(used: (string | null | undefined)[], master: Pick<MasterCampus, 'name'>[]): string[] {
  const have = new Set(master.map((c) => c.name));
  const out = new Set<string>();
  for (const u of used) {
    const c = normalizeCampus(u ?? '');
    if (c && !have.has(c)) out.add(c);
  }
  return [...out].sort();
}
