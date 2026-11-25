/**
 * TEMPORARY "Join the class" form on the homepage (until the school app and
 * this classroom are integrated). Pure rules + request handler with injected
 * deps, unit-tested in tests/joinClassForm.test.ts. To remove the feature,
 * delete this file, src/lib/joinClassSeed.ts, src/app/join-class/,
 * src/app/api/join-class/, src/components/joinClass/, tests/joinClassForm.test.ts,
 * and the "Join the class" button in src/app/page.tsx.
 *
 * The student types a name and picks grade (6–10), campus (Airport, City,
 * Osmanpura) and foundation (Science, Sports, Civil, Fine Arts). Foundation
 * is the school's name for a division and is stored as one. The server
 * resolves the three choices against the admin master lists (canonical names
 * such as AIRPORTCAMPUS / 7 / SCIENCEFOUNDATION) and ignores any other class
 * the browser might send. A join link that already carries Grade, Campus or
 * Foundation/Division is preselected and locked.
 *
 * Not a separate join path: the name + chosen class become the same claims an
 * unsigned school-app link produces (validateUnsignedJoin) and finish with
 * finishStudentJoin; the browser then goes to /student (routing, no-class
 * check, waiting room, admission, one device per student, class-full).
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
export const JOIN_CLASS_DEFAULT = { grade: '7', campus: 'Airport Campus', division: 'Science Foundation' } as const;
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

export const JOIN_FOUNDATION_LABELS = [
  { key: 'SCIENCEFOUNDATION', label: 'Science Foundation' },
  { key: 'SPORTSFOUNDATION', label: 'Sports Foundation' },
  { key: 'CIVILFOUNDATION', label: 'Civil Foundation' },
  { key: 'FINEARTSFOUNDATION', label: 'Fine Arts Foundation' },
] as const;

export const NAME_MAX = 60;
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
  foundationsByGrade: Record<string, JoinChoice[]>;
};

export type JoinFormLocked = { grade: boolean; campus: boolean; division: boolean };

export type JoinFormPrefill = {
  grade: string;
  campus: string;
  division: string;
  locked: JoinFormLocked;
};

export type JoinAudiencePlan = {
  gradesToAdd: { name: string; label: string; sortOrder: number }[];
  campusesToAdd: { name: string; label: string; sortOrder: number }[];
  divisionsToAdd: { gradeName: string; name: string; label: string }[];
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
 * spaces and a trailing "Campus". Division / foundation (within that grade):
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

function advertisedGrades(grades: MasterGrade[]): JoinChoice[] {
  const out: JoinChoice[] = [];
  const seen = new Set<string>();
  for (const want of JOIN_GRADE_LABELS) {
    const g = matchGrade(grades, want.key);
    if (!g || seen.has(g.name)) continue;
    seen.add(g.name);
    out.push({ name: g.name, label: showGradeLabel(g.name, g.label || want.label) });
  }
  return out;
}

function advertisedCampuses(campuses: MasterCampus[]): JoinChoice[] {
  const out: JoinChoice[] = [];
  const seen = new Set<string>();
  for (const want of JOIN_CAMPUS_LABELS) {
    const c = matchCampus(campuses, want.label);
    if (!c || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, label: c.label || want.label });
  }
  return out;
}

function advertisedFoundations(grade: MasterGrade): JoinChoice[] {
  const out: JoinChoice[] = [];
  const seen = new Set<string>();
  for (const want of JOIN_FOUNDATION_LABELS) {
    const d = matchDivision(grade.divisions, want.label);
    if (!d || seen.has(d.name)) continue;
    seen.add(d.name);
    out.push({ name: d.name, label: d.label || want.label });
  }
  return out;
}

/** Active advertised grade / campus / foundation choices from the master lists. */
export function joinOptionsFromMaster(grades: MasterGrade[], campuses: MasterCampus[]): JoinFormOptions {
  const list = advertisedGrades(grades);
  const foundationsByGrade: Record<string, JoinChoice[]> = {};
  for (const g of list) {
    const row = matchGrade(grades, g.name);
    foundationsByGrade[g.name] = row ? advertisedFoundations(row) : [];
  }
  return { grades: list, campuses: advertisedCampuses(campuses), foundationsByGrade };
}

function includeChoice(list: JoinChoice[], choice: JoinChoice): JoinChoice[] {
  if (list.some((x) => x.name === choice.name)) return list;
  return [...list, choice];
}

/**
 * Build the form model: advertised dropdowns, plus any class a join link
 * already names (even if it is outside the usual 6–10 / three campuses /
 * four foundations), which is then preselected and locked.
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
    if (!options.foundationsByGrade[linkGrade.name]) {
      options.foundationsByGrade[linkGrade.name] = advertisedFoundations(linkGrade);
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

  const gradeForDiv = linkGrade ?? matchGrade(grades, JOIN_CLASS_DEFAULT.grade);
  const linkDiv = link.division && gradeForDiv ? matchDivision(gradeForDiv.divisions, link.division) : undefined;
  if (linkDiv && gradeForDiv) {
    locked.division = true;
    const current = options.foundationsByGrade[gradeForDiv.name] ?? [];
    options.foundationsByGrade[gradeForDiv.name] = includeChoice(current, {
      name: linkDiv.name,
      label: linkDiv.label || linkDiv.name,
    });
  }

  const defGrade = matchGrade(grades, JOIN_CLASS_DEFAULT.grade);
  const defCampus = matchCampus(campuses, JOIN_CLASS_DEFAULT.campus);
  const defDiv = defGrade ? matchDivision(defGrade.divisions, JOIN_CLASS_DEFAULT.division) : undefined;

  const grade = linkGrade?.name ?? defGrade?.name ?? options.grades[0]?.name ?? '';
  const campus = linkCampus?.name ?? defCampus?.name ?? options.campuses[0]?.name ?? '';
  const foundations = options.foundationsByGrade[grade] ?? [];
  const division =
    (linkDiv && gradeForDiv && gradeForDiv.name === grade ? linkDiv.name : undefined) ??
    (defDiv && defGrade && defGrade.name === grade ? defDiv.name : undefined) ??
    foundations[0]?.name ??
    '';

  return { options, prefill: { grade, campus, division, locked } };
}

/**
 * What to add to the master lists so the join form (and teacher/admin
 * dropdowns) offer grades 6–10, the three campuses and the four foundations.
 * Existing rows are matched by key (so AIRPORTCAMPUS and a "CITY" campus
 * labelled "City Campus" are reused, never duplicated or renamed). Inactive
 * rows are left inactive and not re-created.
 */
export function planJoinAudience(grades: MasterGrade[], campuses: MasterCampus[]): JoinAudiencePlan {
  const gradesToAdd: JoinAudiencePlan['gradesToAdd'] = [];
  const campusesToAdd: JoinAudiencePlan['campusesToAdd'] = [];
  const divisionsToAdd: JoinAudiencePlan['divisionsToAdd'] = [];

  const gradeNames: { key: string; name: string }[] = [];
  for (const want of JOIN_GRADE_LABELS) {
    const existing = matchGrade(grades, want.key, false);
    if (existing) {
      gradeNames.push({ key: want.key, name: existing.name });
      continue;
    }
    const name = normalizeGrade(want.key);
    gradesToAdd.push({ name, label: want.label, sortOrder: Number(want.key) * 10 });
    gradeNames.push({ key: want.key, name });
  }

  for (const want of JOIN_CAMPUS_LABELS) {
    if (matchCampus(campuses, want.label, false)) continue;
    const maxOrder = Math.max(0, ...campuses.map((c) => c.sortOrder), ...campusesToAdd.map((c) => c.sortOrder));
    campusesToAdd.push({ name: normalizeCampus(want.label), label: want.label, sortOrder: maxOrder + 10 });
  }

  const allGrades: MasterGrade[] = [
    ...grades,
    ...gradesToAdd.map((g) => ({ id: g.name, name: g.name, label: g.label, sortOrder: g.sortOrder, active: true, divisions: [] })),
  ];
  for (const g of gradeNames) {
    const row = matchGrade(allGrades, g.name, false);
    if (!row) continue;
    for (const want of JOIN_FOUNDATION_LABELS) {
      if (matchDivision(row.divisions, want.label, false)) continue;
      divisionsToAdd.push({ gradeName: row.name, name: normalizeDivision(want.label), label: want.label });
    }
  }

  return { gradesToAdd, campusesToAdd, divisionsToAdd };
}

export function planAddsAnything(plan: JoinAudiencePlan): boolean {
  return plan.gradesToAdd.length + plan.campusesToAdd.length + plan.divisionsToAdd.length > 0;
}

/** "  asha   patil " → "asha patil". */
export function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? collapse(raw) : '';
}

/** Validate the typed name (first and last name). Returns the cleaned name or a friendly error. */
export function checkName(raw: unknown): { name: string } | { error: string } {
  const name = cleanName(raw);
  if (!name) return { error: 'Type your name.' };
  if (name.length > NAME_MAX) return { error: `Your name can be at most ${NAME_MAX} letters.` };
  if (!NAME_RE.test(name)) return { error: 'Use only letters, spaces, dots, hyphens and apostrophes in your name.' };
  const words = name.split(' ').filter((w) => /\p{L}/u.test(w));
  if (words.length < 2 || words.some((w) => w.replace(/[^\p{L}]/gu, '').length < 1)) {
    return { error: 'Type your first name and surname, e.g. Asha Patil.' };
  }
  return { name };
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
export const PICK_CLASS = 'Pick your grade, campus and foundation.';
export const UNKNOWN_CLASS = 'That grade, campus or foundation is not available. Pick from the list or ask your teacher.';

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
  missing_details: 'Type your name.',
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
    division: str(body.foundation) || str(body.division),
  };
}

/** POST `{ name, grade, campus, foundation }` → `{ ok, redirect }` or `{ error, field? }`. */
export async function handleJoinForm(body: unknown, deps: JoinFormDeps): Promise<Response> {
  if (deps.mode !== 'unsigned') return json({ error: FORM_ERROR_TEXT.unsigned_disabled }, 403);
  if (deps.limited && (await deps.limited())) return json({ error: FORM_ERROR_TEXT.rate_limited }, 429);
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const checked = checkName(b.name);
  if ('error' in checked) return json({ error: checked.error, field: 'name' }, 400);
  const picked = readClassFields(b);
  if (!picked.grade || !picked.campus || !picked.division) {
    return json({ error: PICK_CLASS, field: !picked.grade ? 'grade' : !picked.campus ? 'campus' : 'foundation' }, 400);
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
      ...splitName(checked.name),
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
