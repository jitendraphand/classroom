/**
 * Pure helpers for the Grade / Division master list (no Prisma), unit-tested.
 */
import { ALL_DIVISIONS, displayDivision, normalizeDivision, normalizeGrade } from './grades';

export type GradeOption = { name: string; label: string; divisions: { name: string; label: string }[] };
export type MasterGrade = {
  id: string;
  name: string;
  label: string;
  sortOrder: number;
  active: boolean;
  divisions: { id: string; name: string; label: string; active: boolean }[];
};

/** A grade with its divisions as found in existing data. */
export type CollectedGrade = { name: string; divisions: string[] };

/**
 * Distinct canonical grades/divisions from data already in use (teacher
 * assignments, timetable slots, overrides, students, class sessions). Same
 * rules as the SQL backfill in the migration: "*" (all divisions) is not a
 * division; numeric grades sort numerically before the others.
 */
export function collectMasterData(
  sources: { grade: string | null | undefined; divisions?: (string | null | undefined)[] }[]
): CollectedGrade[] {
  const map = new Map<string, Set<string>>();
  for (const s of sources) {
    const g = normalizeGrade(s.grade ?? '');
    if (!g) continue;
    const set = map.get(g) ?? new Set<string>();
    map.set(g, set);
    for (const raw of s.divisions ?? []) {
      const d = normalizeDivision(raw ?? '');
      if (d && d !== ALL_DIVISIONS) set.add(d);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => compareGrades(a, b))
    .map(([name, set]) => ({ name, divisions: [...set].sort() }));
}

export function compareGrades(a: string, b: string) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b);
}

/** Entries of `collected` missing from the master list (what a sync would add). */
export function missingFromMaster(collected: CollectedGrade[], master: Pick<MasterGrade, 'name' | 'divisions'>[]) {
  const have = new Map(master.map((g) => [g.name, new Set(g.divisions.map((d) => d.name))]));
  const out: CollectedGrade[] = [];
  for (const c of collected) {
    const divs = have.get(c.name);
    const missing = c.divisions.filter((d) => !divs?.has(d));
    if (!divs || missing.length) out.push({ name: c.name, divisions: missing });
  }
  return out;
}

/** Dropdown data: active grades (in order) with their active divisions. */
export function activeOptions(master: MasterGrade[]): GradeOption[] {
  return [...master]
    .filter((g) => g.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || compareGrades(a.name, b.name))
    .map((g) => ({
      name: g.name,
      label: g.label,
      divisions: g.divisions
        .filter((d) => d.active)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((d) => ({ name: d.name, label: d.label })),
    }));
}

export type Usage = { what: string; count: number; examples: string[] }[];

export function inUse(u: Usage) {
  return u.some((x) => x.count > 0);
}

/** "Used by 2 teacher assignments, 1 timetable slot (Mon 09:00 Maths) …" */
export function describeUsage(u: Usage): string {
  return u
    .filter((x) => x.count > 0)
    .map((x) => `${x.count} ${x.what}${x.examples.length ? ` (${x.examples.slice(0, 3).join('; ')}${x.count > 3 ? '; …' : ''})` : ''}`)
    .join(', ');
}

/** Clean an admin-typed grade into canonical name + display label. */
export function gradeInput(raw: unknown): { name: string; label: string } | null {
  const label = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
  const name = normalizeGrade(label);
  if (!name || !/^[A-Z0-9 .-]+$/.test(name)) return null;
  return { name, label };
}

/** Clean an admin-typed division into canonical name + display label. */
export function divisionInput(raw: unknown): { name: string; label: string } | null {
  const typed = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const name = normalizeDivision(typed);
  if (!name || name === ALL_DIVISIONS || name === 'ALL' || !/^[A-Z0-9]+$/.test(name)) return null;
  // Keep the admin's casing when it is the same word; otherwise the friendly default.
  const label = typed.replace(/\s+/g, '').toUpperCase() === name ? typed : displayDivision(name);
  return { name, label: label.slice(0, 32) };
}

/**
 * Does the master list know this audience? Used to validate new timetable
 * slots, overrides, teacher assignments and ad-hoc classes. An empty master
 * list (not set up yet) accepts everything.
 */
export function audienceProblem(
  master: Pick<MasterGrade, 'name' | 'divisions'>[],
  grade: string,
  divisions: string[],
  allDivisions: boolean
): string | null {
  if (!master.length) return null;
  const g = master.find((x) => x.name === normalizeGrade(grade));
  if (!g) return `Grade ${grade} is not in Grades & divisions. Add it there first.`;
  if (allDivisions) return null;
  const known = new Set(g.divisions.map((d) => d.name));
  const unknown = divisions.map(normalizeDivision).filter((d) => d && !known.has(d));
  if (unknown.length) {
    return `Division ${unknown.map(displayDivision).join(', ')} of grade ${g.name} is not in Grades & divisions. Add it there first.`;
  }
  return null;
}

/** Roster rows must use active master entries (empty master: anything). */
export function rosterAudienceProblem(master: MasterGrade[], grade: string, division: string): string | null {
  if (!master.length) return null;
  const g = master.find((x) => x.name === grade && x.active);
  if (!g) return `grade ${grade} is not an active grade`;
  if (!g.divisions.some((d) => d.name === division && d.active)) return `division ${displayDivision(division)} is not an active division of grade ${grade}`;
  return null;
}

/** (grade, division) pairs students brought from the school app that the master list lacks. */
export function unrecognisedFromStudents(
  groups: { grade: string; division: string; count: number }[],
  master: Pick<MasterGrade, 'name' | 'divisions'>[]
) {
  const have = new Map(master.map((g) => [g.name, new Set(g.divisions.map((d) => d.name))]));
  return groups
    .map((x) => ({ ...x, grade: normalizeGrade(x.grade), division: normalizeDivision(x.division) }))
    .filter((x) => x.grade && x.division && !have.get(x.grade)?.has(x.division))
    .map((x) => ({ ...x, gradeKnown: have.has(x.grade) }))
    .sort((a, b) => compareGrades(a.grade, b.grade) || a.division.localeCompare(b.division));
}

/**
 * Teacher assignments ("7-A", "8-*") that the master list does not know.
 * Pairs the teacher already holds (`keep`) are not re-checked, so editing a
 * teacher with a legacy assignment does not force removing it.
 */
export function assignmentsProblem(
  master: Pick<MasterGrade, 'name' | 'divisions'>[],
  assignments: { grade: string; division: string }[],
  keep: { grade: string; division: string }[] = []
): string | null {
  const held = new Set(keep.map((a) => `${a.grade}|${a.division}`));
  for (const a of assignments) {
    if (held.has(`${a.grade}|${a.division}`)) continue;
    const all = a.division === ALL_DIVISIONS;
    const p = audienceProblem(master, a.grade, all ? [] : [a.division], all);
    if (p) return p;
  }
  return null;
}

export type TeacherGradeChoice = {
  grade: string;
  label: string;
  /** Holds the whole grade ("*"): may pick any division and "All divisions". */
  whole: boolean;
  divisions: { name: string; label: string }[];
};

/**
 * Teacher ad-hoc start choices: only the teacher's assigned grades; divisions
 * are the explicitly assigned ones, plus every active master division of a
 * whole-grade ("*") assignment. Inactive master entries are hidden. With an
 * empty master list the assignments are used as they are.
 */
export function teacherGradeChoices(
  assignments: { grade: string; division: string }[],
  master: MasterGrade[]
): TeacherGradeChoice[] {
  const configured = master.length > 0;
  const byGrade = new Map<string, string[]>();
  for (const a of assignments) byGrade.set(a.grade, [...(byGrade.get(a.grade) ?? []), a.division]);
  const out: (TeacherGradeChoice & { order: number })[] = [];
  for (const [grade, divs] of byGrade) {
    const m = master.find((g) => g.name === grade);
    if (configured && m && !m.active) continue;
    const whole = divs.includes(ALL_DIVISIONS);
    const list = new Map<string, string>();
    for (const d of divs) {
      if (d === ALL_DIVISIONS) continue;
      const md = m?.divisions.find((x) => x.name === d);
      if (md && !md.active) continue;
      list.set(d, md?.label ?? displayDivision(d));
    }
    if (whole) for (const d of m?.divisions ?? []) if (d.active) list.set(d.name, d.label);
    if (!whole && !list.size) continue;
    out.push({
      grade,
      label: m?.label ?? grade,
      whole,
      divisions: [...list.entries()]
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([name, label]) => ({ name, label })),
      order: m?.sortOrder ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return out
    .sort((a, b) => a.order - b.order || compareGrades(a.grade, b.grade))
    .map((c) => ({ grade: c.grade, label: c.label, whole: c.whole, divisions: c.divisions }));
}
