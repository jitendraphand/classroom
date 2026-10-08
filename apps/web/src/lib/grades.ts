/**
 * Grade / division helpers. Grades and divisions are stored as plain
 * normalised strings (grade "7", division "B") on every row; the admin master
 * list (Grade / Division tables, lib/gradeMaster.ts) only feeds dropdowns and
 * validates new entries. Pure module (no Prisma) so it is unit-tested.
 */

/** Division value meaning "every division of the grade". */
export const ALL_DIVISIONS = '*';

/** "Grade 7", " 7 ", "class 7" → "7"; "xii" → "XII". */
export function normalizeGrade(raw: unknown): string {
  let s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  s = s.replace(/^(grade|class|std\.?|standard)\s*/i, '');
  return s.toUpperCase().slice(0, 16);
}

/** Longest campus name accepted. */
export const MAX_CAMPUS_LENGTH = 32;

/**
 * Canonical campus: trimmed, upper-cased, inner spaces removed, so matching is
 * case- and space-insensitive like divisions ("cc", " C C " → "CC";
 * "North Campus" → "NORTHCAMPUS").
 */
export function normalizeCampus(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .slice(0, MAX_CAMPUS_LENGTH);
}

/** Longest division accepted (word divisions such as "Mahaveer"). */
export const MAX_DIVISION_LENGTH = 32;

/**
 * Canonical division: trimmed, upper-cased, inner spaces removed.
 * " b " → "B"; "Mahaveer" / "MAHAVEER" → "MAHAVEER"; "Div A" / "Section-B" → "A" / "B";
 * "all" / "*" → "*". Comparisons everywhere go through this, so matching is
 * case-insensitive; `displayDivision` gives the friendly form back.
 * The prefix is only stripped when followed by a separator, so words that
 * merely start with it ("Divya", "Second") are kept intact.
 */
export function normalizeDivision(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (s === '*' || s === 'ALL') return ALL_DIVISIONS;
  return s
    .replace(/^(?:(?:DIV|SEC)\.\s*|(?:DIV|DIVISION|SECTION|SEC)(?:\s+|\s*[-:]\s*))(?=\S)/, '')
    .replace(/\s+/g, '')
    .slice(0, MAX_DIVISION_LENGTH);
}

/** Friendly form of a canonical division: "A" → "A", "MAHAVEER" → "Mahaveer", "*" → "ALL". */
export function displayDivision(d: string): string {
  if (d === ALL_DIVISIONS) return 'ALL';
  if (d.length > 1 && /^[A-Z]+$/.test(d)) return d.charAt(0) + d.slice(1).toLowerCase();
  return d;
}

export type Assignment = { campus: string; grade: string; division: string };

/** Audience of a class / slot: one campus, one grade, some (or all) divisions. */
export type Audience = { campus: string; grade: string; divisions: string[]; allDivisions: boolean };

/**
 * Parse "7-A, 7-B, 8-*" / "7A 7B 8 ALL" style text from the admin form, for
 * one campus ("CC:7-A" picks another campus per token).
 * Returns normalised, de-duplicated triples; throws on an unparseable token.
 */
export function parseAssignments(text: string, campus: string): Assignment[] {
  const out: Assignment[] = [];
  const seen = new Set<string>();
  const tokens = text
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const raw of tokens) {
    // Optional "CAMPUS@" prefix: "CC@7-A".
    const at = raw.indexOf('@');
    const c = normalizeCampus(at > 0 ? raw.slice(0, at) : campus);
    const tok = at > 0 ? raw.slice(at + 1).trim() : raw;
    if (!c) throw new Error(`Pick a campus for "${raw}".`);
    // "7-A", "7 A", "7/Mahaveer", "Grade 7: Mahaveer", "7A".
    const m = /^(.+?)\s*[-/:\s]\s*(\*|all|[A-Za-z0-9]+)$/i.exec(tok) || /^(\d+)([A-Za-z])$/.exec(tok);
    if (!m) throw new Error(`Cannot read "${tok}". Use grade-division, e.g. 7-A or 8-ALL.`);
    const grade = normalizeGrade(m[1]);
    const division = normalizeDivision(m[2]);
    if (!grade || !division) throw new Error(`Cannot read "${tok}".`);
    const key = `${c}|${grade}|${division}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ campus: c, grade, division });
  }
  return out;
}

/** "CC@7-A": the admin form / API text format (parseAssignments reads it back). */
export function formatAssignment(a: Assignment): string {
  return `${a.campus}@${a.grade}-${displayDivision(a.division)}`;
}

/** "CC · 7-A" for display. */
export function displayAssignment(a: Assignment): string {
  return `${a.campus} · ${a.grade}-${displayDivision(a.division)}`;
}

/** "CC · 7-A, B" or "CC · 7 (all divisions)". */
export function formatAudience(campus: string, grade: string, divisions: string[], allDivisions: boolean): string {
  const c = campus ? `${campus} · ` : '';
  if (allDivisions) return `${c}${grade} (all divisions)`;
  return `${c}${grade}-${[...divisions].sort().map(displayDivision).join(', ')}`;
}

/**
 * May a teacher with these assignments teach this audience?
 * - every requested division must be assigned (or the grade assigned with "*");
 * - "all divisions" needs the whole grade ("*") assigned, because it includes
 *   divisions the teacher may not be assigned to.
 */
export function canTeachAudience(
  assignments: Assignment[],
  campus: string,
  grade: string,
  divisions: string[],
  allDivisions: boolean
): boolean {
  const g = normalizeGrade(grade);
  const c = normalizeCampus(campus);
  const mine = assignments.filter((a) => normalizeCampus(a.campus) === c && normalizeGrade(a.grade) === g);
  if (!mine.length) return false;
  const whole = mine.some((a) => normalizeDivision(a.division) === ALL_DIVISIONS);
  if (allDivisions) return whole;
  const divs = divisions.map(normalizeDivision).filter(Boolean);
  if (!divs.length) return false;
  if (whole) return true;
  const set = new Set(mine.map((a) => normalizeDivision(a.division)));
  return divs.every((d) => set.has(d));
}

/** Does a (campus, grade, division) student belong to this audience? */
export function audienceIncludes(
  audience: Audience,
  student: { campus: string; grade: string; division: string }
): boolean {
  const { campus, grade, division } = student;
  if (normalizeCampus(audience.campus) !== normalizeCampus(campus)) return false;
  if (normalizeGrade(audience.grade) !== normalizeGrade(grade)) return false;
  if (audience.allDivisions) return true;
  const d = normalizeDivision(division);
  return audience.divisions.some((x) => normalizeDivision(x) === d);
}

/** Do two audiences share at least one campus-grade-division? */
export function audiencesOverlap(a: Audience, b: Audience): boolean {
  if (normalizeCampus(a.campus) !== normalizeCampus(b.campus)) return false;
  if (normalizeGrade(a.grade) !== normalizeGrade(b.grade)) return false;
  if (a.allDivisions || b.allDivisions) return true;
  const set = new Set(a.divisions.map(normalizeDivision));
  return b.divisions.some((d) => set.has(normalizeDivision(d)));
}

/** "A, B" → {divisions:["A","B"]}; "ALL" / "*" → {allDivisions:true}. */
export function parseDivisionList(raw: string | string[]): { divisions: string[]; allDivisions: boolean } {
  const items = (Array.isArray(raw) ? raw : raw.split(/[,;\s/]+/)).map(normalizeDivision).filter(Boolean);
  if (items.includes(ALL_DIVISIONS)) return { divisions: [], allDivisions: true };
  return { divisions: [...new Set(items)].sort(), allDivisions: false };
}
