/**
 * TEMPORARY "Join the class" form on the homepage (until the school app and
 * this classroom are integrated). Pure rules + request handler with injected
 * deps, unit-tested in tests/joinClassForm.test.ts. To remove the feature,
 * delete this file, src/lib/joinClassSeed.ts, src/app/join-class/,
 * src/app/api/join-class/, src/components/joinClass/, tests/joinClassForm.test.ts,
 * and the "Join the class" button in src/app/page.tsx.
 *
 * The student types a first name and last name, then picks campus, grade and
 * division (Nov 27: "foundation" removed; one filter, division). Every choice
 * comes from the admin's master lists: active campuses, active grades, and the
 * active divisions of the chosen grade (Admin → Grades & divisions). The
 * dropdowns start on a "Select …" placeholder; only a join link that already
 * carries Campus, Grade or Division is preselected and locked.
 * The two name parts are stored as the existing combined `name` ("First Last")
 * so returning students still match. The server resolves the three class
 * choices against the admin master lists (canonical names such as
 * AIRPORTCAMPUS / 7 / A) and ignores any other class the
 * browser might send.
 *
 * Not a separate join path: the name + chosen class become the same claims an
 * unsigned school-app link produces (validateUnsignedJoin) and finish with
 * finishStudentJoin; the browser then goes to /student (routing, no-class
 * check, admission, one device per student, class-full).
 *
 * Identity (attendance + one device per student) = the typed name within the
 * chosen class, compared case-, accent- and spacing-insensitively:
 *  - one live student on file in that class with that name (admin import,
 *    earlier form join, school-app link) → that record is reused;
 *  - several on file with the same name → refused, "ask your teacher";
 *  - none → a stable ID derived from campus|grade|division|name (`WEB-<hash>`),
 *    so the same name in the same class gets the same record every day, on any
 *    device.
 * Known limits (see the report): two classmates with the same full name share
 * one seat; a typo makes a second record. STUDENT_REGISTRY strict (or auto
 * after an import) refuses names that are not on file, like an unknown SID.
 */
import { createHash } from 'node:crypto';
import type { MasterCampus } from './campusLogic';
import { normalizeCampus, normalizeDivision, normalizeGrade } from './grades';
import type { MasterGrade } from './gradeMasterLogic';
import { validateUnsignedJoin, type SchoolJoinMode } from './schoolJoin';
import { JoinTokenError, type JoinClaims, type JoinErrorCode } from './schoolJwt';

/** Default selection when the student (or the link) does not pick a class. */
export const JOIN_CLASS_DEFAULT = { grade: '7', campus: 'Airport Campus', division: 'A' } as const;
/** @deprecated Use JOIN_CLASS_DEFAULT. Kept so older tests and comments still compile. */
export const JOIN_CLASS_FIXED = JOIN_CLASS_DEFAULT;

export const JOIN_GRADE_LABELS = [
  { key: '6', label: 'Grade 6' },
  { key: '7', label: 'Grade 7' },
  { key: '8', label: 'Grade 8' },
  { key: '9', label: 'Grade 9' },
  { key: '10', label: 'Grade 10' },
] as const;

export const JOIN_CAMPUS_LABELS = [
  { key: 'AIRPORT', label: 'Airport Campus' },
  { key: 'CITY', label: 'City Campus' },
  { key: 'OSMANPURA', label: 'Osmanpura Campus' },
] as const;

export const FIRST_MAX = 50;
export const LAST_MAX = 50;
const NAME_RE = /^[\p{L}\p{M} .'’-]+$/u;

/** One resolved class as stored in the master lists (canonical names + labels to show). */
export type FixedClass = {
  campus: string;
  campusLabel: string;
  grade: string;
  gradeLabel: string;
  division: string;
  divisionLabel: string;
};

export type JoinChoice = { name: string; label: string };

export type JoinFormOptions = {
  grades: JoinChoice[];
  campuses: JoinChoice[];
  /** Active divisions of each grade (canonical grade name → choices). */
  divisionsByGrade: Record<string, JoinChoice[]>;
};

export type JoinFormLocked = { grade: boolean; campus: boolean; division: boolean };

export type JoinFormPrefill = {
  grade: string;
  campus: string;
  division: string;
  locked: JoinFormLocked;
};

/** Divisions are never seeded (Nov 27): the admin creates them. */
export type JoinAudiencePlan = {
  gradesToAdd: { name: string; label: string; sortOrder: number }[];
  campusesToAdd: { name: string; label: string; sortOrder: number }[];
};

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');

/** "Grade 7" / "Class 7" / "7th" / "7" → "7". */
export function gradeKey(raw: string): string {
  return normalizeGrade(raw).replace(/^(\d+)\s*(ST|ND|RD|TH)$/, '$1');
}

/** "Airport Campus" / "AIRPORTCAMPUS" / "airport campus" → "AIRPORT". */
export function campusKey(raw: string): string {
  return normalizeCampus(raw).replace(/CAMPUS$/, '') || normalizeCampus(raw);
}

function showGradeLabel(name: string, label: string): string {
  const t = (label || name).trim() || name;
  if (/^\d+$/.test(t)) return `Grade ${t}`;
  return t;
}

function matchGrade(grades: MasterGrade[], raw: string, activeOnly = true): MasterGrade | undefined {
  const gk = gradeKey(raw);
  if (!gk) return undefined;
  return [...grades]
    .filter((x) => (!activeOnly || x.active) && (gradeKey(x.name) === gk || gradeKey(x.label) === gk))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
}

function matchCampus(campuses: MasterCampus[], raw: string, activeOnly = true): MasterCampus | undefined {
  const ck = campusKey(raw);
  if (!ck) return undefined;
  return [...campuses]
    .filter((x) => (!activeOnly || x.active) && (campusKey(x.name) === ck || campusKey(x.label) === ck))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
}

function matchDivision(
  divisions: { name: string; label: string; active: boolean }[],
  raw: string,
  activeOnly = true,
): { name: string; label: string; active: boolean } | undefined {
  const want = collapse(raw).toLowerCase();
  const wantName = normalizeDivision(raw);
  if (!wantName) return undefined;
  return divisions.find(
    (x) =>
      (!activeOnly || x.active) &&
      (collapse(x.label).toLowerCase() === want || x.name.toLowerCase() === want || x.name === wantName),
  );
}

/**
 * Find a class in the master lists (active rows only). Grade: name or label
 * with the same grade number. Campus: name or label equal ignoring case,
 * spaces and a trailing "Campus". Division (within that grade):
 * name or label equal ignoring case (and the inner spaces the canonical name
 * drops). `null` when any of the three is missing.
 */
export function resolveJoinClass(
  grades: MasterGrade[],
  campuses: MasterCampus[],
  picked: { grade: string; campus: string; division: string },
): FixedClass | null {
  const g = matchGrade(grades, picked.grade);
  const c = matchCampus(campuses, picked.campus);
  if (!g || !c) return null;
  const d = matchDivision(g.divisions, picked.division);
  if (!d) return null;
  return {
    campus: c.name,
    campusLabel: c.label || c.name,
    grade: g.name,
    gradeLabel: showGradeLabel(g.name, g.label || g.name),
    division: d.name,
    divisionLabel: d.label || d.name,
  };
}

/** @deprecated Use resolveJoinClass. */
export function resolveFixedClass(
  grades: MasterGrade[],
  campuses: MasterCampus[],
  fixed: { grade: string; campus: string; division: string } = JOIN_CLASS_DEFAULT,
): FixedClass | null {
  return resolveJoinClass(grades, campuses, fixed);
}

/** Every active grade, in the admin's order. */
function activeGrades(grades: MasterGrade[]): JoinChoice[] {
  return [...grades]
    .filter((g) => g.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((g) => ({ name: g.name, label: showGradeLabel(g.name, g.label || g.name) }));
}

/** Every active campus, in the admin's order. */
function activeCampuses(campuses: MasterCampus[]): JoinChoice[] {
  return [...campuses]
    .filter((c) => c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, label: c.label || c.name }));
}

/** Every active division of a grade, by label ("A", "B", … or names). */
function activeDivisions(grade: MasterGrade): JoinChoice[] {
  return grade.divisions
    .filter((d) => d.active)
    .map((d) => ({ name: d.name, label: d.label || d.name }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** The form's choices: everything active in the admin's master lists. */
export function joinOptionsFromMaster(grades: MasterGrade[], campuses: MasterCampus[]): JoinFormOptions {
  const list = activeGrades(grades);
  const divisionsByGrade: Record<string, JoinChoice[]> = {};
  for (const g of list) {
    const row = grades.find((x) => x.name === g.name);
    divisionsByGrade[g.name] = row ? activeDivisions(row) : [];
  }
  return { grades: list, campuses: activeCampuses(campuses), divisionsByGrade };
}

function includeChoice(list: JoinChoice[], choice: JoinChoice): JoinChoice[] {
  if (list.some((x) => x.name === choice.name)) return list;
  return [...list, choice];
}

/**
 * Build the form model: advertised dropdowns, plus any class a join link
 * already names, which is then preselected and locked.
 */
export function joinFormModel(
  grades: MasterGrade[],
  campuses: MasterCampus[],
  link: { grade?: string; campus?: string; division?: string } = {},
): { options: JoinFormOptions; prefill: JoinFormPrefill } {
  const options = joinOptionsFromMaster(grades, campuses);
  const locked: JoinFormLocked = { grade: false, campus: false, division: false };

  const linkGrade = link.grade ? matchGrade(grades, link.grade) : undefined;
  if (linkGrade) {
    locked.grade = true;
    options.grades = includeChoice(options.grades, {
      name: linkGrade.name,
      label: showGradeLabel(linkGrade.name, linkGrade.label || linkGrade.name),
    });
    if (!options.divisionsByGrade[linkGrade.name]) {
      options.divisionsByGrade[linkGrade.name] = activeDivisions(linkGrade);
    }
  }

  const linkCampus = link.campus ? matchCampus(campuses, link.campus) : undefined;
  if (linkCampus) {
    locked.campus = true;
    options.campuses = includeChoice(options.campuses, {
      name: linkCampus.name,
      label: linkCampus.label || linkCampus.name,
    });
  }

  // A division in the link is only locked when the grade is also named:
  // the same label ("A") can exist on every grade, so we cannot guess.
  const linkDiv = link.division && linkGrade ? matchDivision(linkGrade.divisions, link.division) : undefined;
  if (linkDiv && linkGrade) {
    locked.division = true;
    const current = options.divisionsByGrade[linkGrade.name] ?? [];
    options.divisionsByGrade[linkGrade.name] = includeChoice(current, {
      name: linkDiv.name,
      label: linkDiv.label || linkDiv.name,
    });
  }

  return {
    options,
    prefill: {
      grade: linkGrade?.name ?? '',
      campus: linkCampus?.name ?? '',
      division: linkDiv?.name ?? '',
      locked,
    },
  };
}

/**
 * First-run convenience: grades 6–10 and the school's three campuses are
 * added when missing, so a new server has something to pick. Divisions are
 * never added (Nov 27): the admin creates them (Admin → Grades & divisions).
 * Existing rows are matched by key and never renamed; inactive rows stay
 * inactive and are not re-created.
 */
export function planJoinAudience(grades: MasterGrade[], campuses: MasterCampus[]): JoinAudiencePlan {
  const gradesToAdd: JoinAudiencePlan['gradesToAdd'] = [];
  const campusesToAdd: JoinAudiencePlan['campusesToAdd'] = [];
  for (const want of JOIN_GRADE_LABELS) {
    if (matchGrade(grades, want.key, false)) continue;
    gradesToAdd.push({ name: normalizeGrade(want.key), label: want.label, sortOrder: Number(want.key) * 10 });
  }
  for (const want of JOIN_CAMPUS_LABELS) {
    if (matchCampus(campuses, want.label, false)) continue;
    const maxOrder = Math.max(0, ...campuses.map((c) => c.sortOrder), ...campusesToAdd.map((c) => c.sortOrder));
    campusesToAdd.push({ name: normalizeCampus(want.label), label: want.label, sortOrder: maxOrder + 10 });
  }
  return { gradesToAdd, campusesToAdd };
}

export function planAddsAnything(plan: JoinAudiencePlan): boolean {
  return plan.gradesToAdd.length + plan.campusesToAdd.length > 0;
}

/** "  asha   patil " → "asha patil". */
export function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? collapse(raw) : '';
}

function checkNamePart(raw: unknown, which: 'first' | 'last'): { name: string } | { error: string } {
  const name = cleanName(raw);
  const label = which === 'first' ? 'first name' : 'last name';
  const max = which === 'first' ? FIRST_MAX : LAST_MAX;
  if (!name) return { error: `Type your ${label}.` };
  if (name.length > max) return { error: `Your ${label} can be at most ${max} letters.` };
  if (!NAME_RE.test(name) || !/\p{L}/u.test(name)) {
    return { error: 'Use only letters, spaces, dots, hyphens and apostrophes in your name.' };
  }
  return { name };
}

/** Validate first + last name. Combined `name` is "First Last", the stored student name. */
export function checkNames(
  first: unknown,
  last: unknown,
): { firstName: string; lastName: string; name: string } | { error: string; field: 'firstName' | 'lastName' } {
  const f = checkNamePart(first, 'first');
  if ('error' in f) return { error: f.error, field: 'firstName' };
  const l = checkNamePart(last, 'last');
  if ('error' in l) return { error: l.error, field: 'lastName' };
  return { firstName: f.name, lastName: l.name, name: `${f.name} ${l.name}` };
}

/** Name as compared: no Latin accents, lower-case, letters (and Indic vowel signs) with single spaces. */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Latin accents only; Indic vowel signs are part of the name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}]+/gu, ' ')
    .trim();
}

/** Stable student ID for a name not on file yet. */
export function formStudentId(cls: Pick<FixedClass, 'campus' | 'grade' | 'division'>, name: string): string {
  const h = createHash('sha256').update(`${cls.campus}|${cls.grade}|${cls.division}|${nameKey(name)}`).digest('hex').slice(0, 20);
  return `WEB-${h}`;
}

export type OnFile = { externalId: string; name: string };

/** Pick the student ID: the one record on file with this name, else a derived one. */
export function pickStudentId(cls: FixedClass, name: string, onFile: OnFile[]): { sid: string } | { error: 'ambiguous' } {
  const key = nameKey(name);
  const same = onFile.filter((s) => nameKey(s.name) === key);
  if (same.length > 1) return { error: 'ambiguous' };
  return { sid: same[0]?.externalId ?? formStudentId(cls, name) };
}

/** "Asha Kumar Patil" → first "Asha", last "Kumar Patil". */
export function splitName(name: string): { firstName: string; lastName: string } | { firstName: string; lastName?: string } {
  const [first, ...rest] = name.split(' ');
  const last = rest.join(' ');
  return { firstName: first!.slice(0, 50), ...(last ? { lastName: last.slice(0, 50) } : {}) };
}

export const NOT_AVAILABLE = 'Joining is not available right now. Please ask your teacher.';
export const PICK_CLASS = 'Pick your campus, grade and division.';
export const UNKNOWN_CLASS = 'That campus, grade or division is not available. Pick from the list or ask your teacher.';

/** Friendly text for the form (the school-app wording in JOIN_ERROR_TEXT talks about links). */
export const FORM_ERROR_TEXT: Partial<Record<JoinErrorCode | 'ambiguous' | 'pick_class' | 'unknown_class', string>> & {
  default: string;
} = {
  ambiguous: 'More than one student in this class has this name. Please ask your teacher.',
  unknown_student: 'Your name is not on the school list for this class. Check the spelling or ask your teacher.',
  campus_required: NOT_AVAILABLE,
  rate_limited: 'Too many tries. Wait a minute and try again.',
  unsigned_disabled: 'Joining with this form is switched off here. Open your class from the school app.',
  invalid_details: 'Your name could not be read. Use letters only and try again.',
  missing_details: 'Type your first name and last name.',
  pick_class: PICK_CLASS,
  unknown_class: UNKNOWN_CLASS,
  default: 'Something went wrong. Wait a moment and try again.',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export type JoinFormDeps = {
  mode: SchoolJoinMode;
  grades: () => Promise<MasterGrade[]>;
  campuses: () => Promise<MasterCampus[]>;
  /** Live students on file in this class. */
  onFile: (cls: FixedClass) => Promise<OnFile[]>;
  limited?: () => Promise<boolean>;
  finish: (claims: JoinClaims, signed: boolean) => Promise<void>;
};

function readClassFields(body: Record<string, unknown>): { grade: string; campus: string; division: string } {
  const str = (v: unknown) => (typeof v === 'string' ? collapse(v) : '');
  return {
    grade: str(body.grade),
    campus: str(body.campus),
    // `foundation` is the field name older pages sent.
    division: str(body.division) || str(body.foundation),
  };
}

/** POST `{ firstName, lastName, campus, grade, division }` → `{ ok, redirect }` or `{ error, field? }`. */
export async function handleJoinForm(body: unknown, deps: JoinFormDeps): Promise<Response> {
  if (deps.mode !== 'unsigned') return json({ error: FORM_ERROR_TEXT.unsigned_disabled }, 403);
  if (deps.limited && (await deps.limited())) return json({ error: FORM_ERROR_TEXT.rate_limited }, 429);
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const checked = checkNames(b.firstName, b.lastName);
  if ('error' in checked) return json({ error: checked.error, field: checked.field }, 400);
  const picked = readClassFields(b);
  if (!picked.grade || !picked.campus || !picked.division) {
    return json({ error: PICK_CLASS, field: !picked.campus ? 'campus' : !picked.grade ? 'grade' : 'division' }, 400);
  }
  try {
    const grades = await deps.grades();
    const campuses = await deps.campuses();
    const cls = resolveJoinClass(grades, campuses, picked);
    if (!cls) {
      const options = joinOptionsFromMaster(grades, campuses);
      const none = !options.grades.length || !options.campuses.length;
      return json(
        { error: none ? NOT_AVAILABLE : UNKNOWN_CLASS, code: none ? 'not_available' : 'unknown_class' },
        none ? 503 : 400,
      );
    }
    const sid = pickStudentId(cls, checked.name, await deps.onFile(cls));
    if ('error' in sid) return json({ error: FORM_ERROR_TEXT.ambiguous, field: 'name' }, 409);
    const claims = validateUnsignedJoin({
      sid: sid.sid,
      firstName: checked.firstName,
      lastName: checked.lastName,
      grade: cls.grade,
      division: cls.division,
      campus: cls.campus,
    });
    await deps.finish(claims, false);
    return json({ ok: true, redirect: '/student' });
  } catch (e) {
    if (e instanceof JoinTokenError) {
      const status = e.code === 'rate_limited' ? 429 : e.code === 'unknown_student' ? 404 : 400;
      return json({ error: FORM_ERROR_TEXT[e.code] ?? FORM_ERROR_TEXT.default, code: e.code }, status);
    }
    console.error('join form failed', e instanceof Error ? e.message : e);
    return json({ error: FORM_ERROR_TEXT.default }, 503);
  }
}
