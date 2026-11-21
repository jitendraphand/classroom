/**
 * TEMPORARY "Join the class" form on the homepage (until the school app and
 * this classroom are integrated). Pure rules + request handler with injected
 * deps, unit-tested in tests/joinClassForm.test.ts. To remove the feature,
 * delete this file, src/app/join-class/, src/app/api/join-class/,
 * src/components/joinClass/, tests/joinClassForm.test.ts, and the
 * "Join the class" button in src/app/page.tsx.
 *
 * The class is fixed (JOIN_CLASS_FIXED): the student only types a name. The
 * server ignores any grade / campus / division the browser sends.
 *
 * Not a separate join path: the name + fixed class become the same claims an
 * unsigned school-app link produces (validateUnsignedJoin) and finish with
 * finishStudentJoin; the browser then goes to /student (routing, no-class
 * check, waiting room, admission, one device per student, class-full).
 *
 * Identity (attendance + one device per student) = the typed name within the
 * fixed class, compared case-, accent- and spacing-insensitively:
 *  - one live student on file in that class with that name (admin import,
 *    earlier form join, school-app link) → that record is reused;
 *  - several on file with the same name → refused, "ask your teacher";
 *  - none → a stable ID derived from campus|grade|division|name (`WEB-<hash>`),
 *    so the same name gets the same record every day, on any device.
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

/** The one class this temporary form joins. Change or delete here only. */
export const JOIN_CLASS_FIXED = { grade: '7', campus: 'Airport Campus', division: 'Science Foundation' } as const;

export const NAME_MAX = 60;
const NAME_RE = /^[\p{L}\p{M} .'’-]+$/u;

/** The fixed class as stored in the master lists (canonical names + labels to show). */
export type FixedClass = {
  campus: string;
  campusLabel: string;
  grade: string;
  gradeLabel: string;
  division: string;
  divisionLabel: string;
};

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');

/** "Grade 7" / "Class 7" / "7th" / "7" → "7". */
export function gradeKey(raw: string): string {
  return normalizeGrade(raw).replace(/^(\d+)\s*(ST|ND|RD|TH)$/, '$1');
}

/** "Airport Campus" / "AIRPORT" / "airport campus" → "AIRPORT". */
export function campusKey(raw: string): string {
  return normalizeCampus(raw).replace(/CAMPUS$/, '') || normalizeCampus(raw);
}

/**
 * Find the fixed class in the master lists (active rows only). Grade: name or
 * label with the same grade number. Campus: name or label equal ignoring case,
 * spaces and a trailing "Campus". Division (within that grade): name or label
 * equal ignoring case (and the inner spaces the canonical name drops).
 * `null` when any of the three is missing.
 */
export function resolveFixedClass(
  grades: MasterGrade[],
  campuses: MasterCampus[],
  fixed: { grade: string; campus: string; division: string } = JOIN_CLASS_FIXED,
): FixedClass | null {
  const gk = gradeKey(fixed.grade);
  const g = [...grades]
    .filter((x) => x.active && (gradeKey(x.name) === gk || gradeKey(x.label) === gk))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const ck = campusKey(fixed.campus);
  const c = [...campuses]
    .filter((x) => x.active && (campusKey(x.name) === ck || campusKey(x.label) === ck))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  if (!g || !c) return null;
  const want = collapse(fixed.division).toLowerCase();
  const wantName = normalizeDivision(fixed.division);
  const d = g.divisions.find(
    (x) => x.active && (collapse(x.label).toLowerCase() === want || x.name.toLowerCase() === want || x.name === wantName),
  );
  if (!d) return null;
  return { campus: c.name, campusLabel: c.label || c.name, grade: g.name, gradeLabel: g.label || g.name, division: d.name, divisionLabel: d.label || d.name };
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
export function splitName(name: string): { firstName: string; lastName?: string } {
  const [first, ...rest] = name.split(' ');
  const last = rest.join(' ');
  return { firstName: first!.slice(0, 50), ...(last ? { lastName: last.slice(0, 50) } : {}) };
}

export const NOT_AVAILABLE = 'Joining is not available right now. Please ask your teacher.';

/** Friendly text for the form (the school-app wording in JOIN_ERROR_TEXT talks about links). */
export const FORM_ERROR_TEXT: Partial<Record<JoinErrorCode | 'ambiguous', string>> & { default: string } = {
  ambiguous: 'More than one student in this class has this name. Please ask your teacher.',
  unknown_student: 'Your name is not on the school list for this class. Check the spelling or ask your teacher.',
  campus_required: NOT_AVAILABLE,
  rate_limited: 'Too many tries. Wait a minute and try again.',
  unsigned_disabled: 'Joining with this form is switched off here. Open your class from the school app.',
  invalid_details: 'Your name could not be read. Use letters only and try again.',
  missing_details: 'Type your name.',
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

/** POST `{ name }` (anything else is ignored) → `{ ok, redirect }` or `{ error, field? }`. */
export async function handleJoinForm(body: unknown, deps: JoinFormDeps): Promise<Response> {
  if (deps.mode !== 'unsigned') return json({ error: FORM_ERROR_TEXT.unsigned_disabled }, 403);
  if (deps.limited && (await deps.limited())) return json({ error: FORM_ERROR_TEXT.rate_limited }, 429);
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const checked = checkName(b.name);
  if ('error' in checked) return json({ error: checked.error, field: 'name' }, 400);
  try {
    const cls = resolveFixedClass(await deps.grades(), await deps.campuses());
    if (!cls) return json({ error: NOT_AVAILABLE, code: 'not_available' }, 503);
    const picked = pickStudentId(cls, checked.name, await deps.onFile(cls));
    if ('error' in picked) return json({ error: FORM_ERROR_TEXT.ambiguous, field: 'name' }, 409);
    const claims = validateUnsignedJoin({
      sid: picked.sid,
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
