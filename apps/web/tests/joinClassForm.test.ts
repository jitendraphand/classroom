import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import type { MasterCampus } from '../src/lib/campusLogic';
import type { MasterGrade } from '../src/lib/gradeMasterLogic';
import type { JoinClaims } from '../src/lib/schoolJwt';
import { JoinTokenError } from '../src/lib/schoolJwt';
import { normalizeCampus, normalizeDivision } from '../src/lib/grades';
import { readUnsignedFields } from '../src/lib/joinParams';
import {
  JOIN_CLASS_DEFAULT,
  JOIN_CLASS_FIXED,
  NOT_AVAILABLE,
  PICK_CLASS,
  UNKNOWN_CLASS,
  campusKey,
  checkNames,
  formStudentId,
  gradeKey,
  handleJoinForm,
  joinFormModel,
  joinOptionsFromMaster,
  nameKey,
  pickStudentId,
  planAddsAnything,
  planJoinAudience,
  resolveFixedClass,
  resolveJoinClass,
  splitName,
  type JoinFormDeps,
  type OnFile,
} from '../src/lib/joinClassForm';

const div = (name: string, label: string, active = true) => ({ id: name, name, label, active });
const grade = (
  id: string,
  name: string,
  label: string,
  sortOrder: number,
  divisions: ReturnType<typeof div>[],
  active = true,
): MasterGrade => ({ id, name, label, sortOrder, active, divisions });

const DIVS = [div('A', 'A'), div('B', 'B'), div('C', 'C')];

const GRADES: MasterGrade[] = [
  grade('g6', '6', '6', 10, [div('A', 'A')]),
  grade('g7', '7', 'Grade 7', 20, [div('A', 'A'), div('B', 'B'), div('MAHAVEER', 'Mahaveer'), div('OLD', 'Old', false)]),
];
const CAMPUSES: MasterCampus[] = [
  { id: 'c1', name: 'CITY', label: 'City Campus', sortOrder: 1, active: true },
  { id: 'c2', name: 'AIRPORTCAMPUS', label: 'Airport Campus', sortOrder: 2, active: true },
];
const CLS = resolveJoinClass(GRADES, CAMPUSES, JOIN_CLASS_DEFAULT)!;

test('default class constant is Grade 7 / Airport Campus / A (no foundation)', () => {
  assert.deepEqual({ ...JOIN_CLASS_DEFAULT }, { grade: '7', campus: 'Airport Campus', division: 'A' });
  assert.equal(JOIN_CLASS_FIXED, JOIN_CLASS_DEFAULT);
});

test('grade and campus keys tolerate the usual spellings', () => {
  for (const g of ['7', '7th', 'Grade 7', 'class 7', ' 7TH ']) assert.equal(gradeKey(g), '7', g);
  assert.notEqual(gradeKey('17'), '7');
  for (const c of ['Airport Campus', 'AIRPORTCAMPUS', 'airport', 'Airport']) assert.equal(campusKey(c), 'AIRPORT', c);
  assert.notEqual(campusKey('City Campus'), 'AIRPORT');
  assert.equal(campusKey('City Campus'), 'CITY');
  assert.equal(campusKey('Osmanpura Campus'), 'OSMANPURA');
  assert.equal(normalizeCampus('Osmanpura Campus'), 'OSMANPURACAMPUS');
  assert.equal(normalizeDivision('Division A'), 'A');
  assert.equal(normalizeDivision('Mahaveer'), 'MAHAVEER');
});

test('resolveJoinClass finds the stored records and returns their exact names and labels', () => {
  assert.deepEqual(CLS, {
    campus: 'AIRPORTCAMPUS',
    campusLabel: 'Airport Campus',
    grade: '7',
    gradeLabel: 'Grade 7',
    division: 'A',
    divisionLabel: 'A',
  });
  // Grade stored as "7TH", campus as "AIRPORT", division label in other case.
  const g7th: MasterGrade[] = [grade('g7', '7TH', '7th', 20, [div('A', 'a')])];
  const air: MasterCampus[] = [{ id: 'x', name: 'AIRPORT', label: 'Airport', sortOrder: 1, active: true }];
  const r = resolveJoinClass(g7th, air, JOIN_CLASS_DEFAULT)!;
  assert.equal(r.grade, '7TH');
  assert.equal(r.campus, 'AIRPORT');
  assert.equal(r.division, 'A');
  assert.equal(resolveFixedClass(g7th, air)?.campus, 'AIRPORT');
});

test('resolveJoinClass is null when grade, campus or division is missing or inactive', () => {
  assert.equal(resolveJoinClass([], CAMPUSES, JOIN_CLASS_DEFAULT), null);
  assert.equal(resolveJoinClass(GRADES, [CAMPUSES[0]!], JOIN_CLASS_DEFAULT), null);
  assert.equal(resolveJoinClass(GRADES, [{ ...CAMPUSES[1]!, active: false }], JOIN_CLASS_DEFAULT), null);
  assert.equal(resolveJoinClass([grade('g7', '7', 'Grade 7', 20, [div('B', 'B')])], CAMPUSES, JOIN_CLASS_DEFAULT), null);
  assert.equal(resolveJoinClass([grade('g7', '7', 'Grade 7', 20, [div('A', 'A', false)])], CAMPUSES, JOIN_CLASS_DEFAULT), null);
  assert.equal(resolveJoinClass([grade('g7', '7', 'Grade 7', 20, DIVS, false)], CAMPUSES, JOIN_CLASS_DEFAULT), null);
  // Exact match only: "AB" is not "A".
  assert.equal(resolveJoinClass([grade('g7', '7', 'Grade 7', 20, [div('AB', 'AB')])], CAMPUSES, JOIN_CLASS_DEFAULT), null);
});

test("joinOptionsFromMaster offers everything active in the admin's lists", () => {
  const full = [
    grade('g6', '6', 'Grade 6', 60, DIVS),
    grade('g7', '7', 'Grade 7', 70, [...DIVS, div('MAHAVEER', 'Mahaveer'), div('OLD', 'Old', false)]),
    grade('g11', '11', 'Grade 11', 110, DIVS),
    grade('g12', '12', 'Grade 12', 120, DIVS, false),
  ];
  const campuses: MasterCampus[] = [
    { id: 'c1', name: 'CITY', label: 'City Campus', sortOrder: 1, active: true },
    { id: 'c2', name: 'AIRPORTCAMPUS', label: 'Airport Campus', sortOrder: 2, active: true },
    { id: 'c4', name: 'OTHER', label: 'Other', sortOrder: 4, active: true },
    { id: 'c5', name: 'GONE', label: 'Gone', sortOrder: 5, active: false },
  ];
  const opts = joinOptionsFromMaster(full, campuses);
  assert.deepEqual(opts.grades.map((g) => g.name), ['6', '7', '11']);
  assert.deepEqual(opts.campuses.map((c) => c.name), ['CITY', 'AIRPORTCAMPUS', 'OTHER']);
  assert.deepEqual(opts.divisionsByGrade['7']!.map((d) => d.name), ['A', 'B', 'C', 'MAHAVEER']);
  assert.equal(opts.grades.find((g) => g.name === '6')!.label, 'Grade 6');
  assert.equal('foundationsByGrade' in opts, false);
});

test('joinFormModel locks values a join link already carries, including a non-advertised division', () => {
  const model = joinFormModel(GRADES, CAMPUSES, {
    grade: 'Grade 7',
    campus: 'airport campus',
    division: 'Mahaveer',
  });
  assert.deepEqual(model.prefill.locked, { grade: true, campus: true, division: true });
  assert.equal(model.prefill.grade, '7');
  assert.equal(model.prefill.campus, 'AIRPORTCAMPUS');
  assert.equal(model.prefill.division, 'MAHAVEER');
  assert.ok(model.options.divisionsByGrade['7']!.some((d) => d.name === 'MAHAVEER'));

  const partial = joinFormModel(GRADES, CAMPUSES, { campus: 'CITY' });
  assert.equal(partial.prefill.campus, 'CITY');
  assert.equal(partial.prefill.locked.campus, true);
  assert.equal(partial.prefill.locked.grade, false);
  assert.equal(partial.prefill.locked.division, false);
  assert.equal(partial.prefill.grade, '');
  assert.equal(partial.prefill.division, '');

  const empty = joinFormModel(GRADES, CAMPUSES, {});
  assert.deepEqual(empty.prefill, { grade: '', campus: '', division: '', locked: { grade: false, campus: false, division: false } });

  // A division without a grade is not locked: it exists on more than one grade.
  const onlyDiv = joinFormModel(GRADES, CAMPUSES, { division: 'A' });
  assert.equal(onlyDiv.prefill.division, '');
  assert.equal(onlyDiv.prefill.locked.division, false);
});

test('Foundation is accepted as a Division alias on join links', () => {
  const f = readUnsignedFields(new URLSearchParams('Grade=8&Campus=City Campus&Foundation=Sports Foundation'));
  assert.equal(f.grade, '8');
  assert.equal(f.campus, 'City Campus');
  assert.equal(f.division, 'Sports Foundation');
});

test('planJoinAudience adds missing grades and campuses, never divisions, without renaming existing codes', () => {
  const plan = planJoinAudience(GRADES, CAMPUSES);
  assert.ok(planAddsAnything(plan));
  assert.deepEqual(
    plan.gradesToAdd.map((g) => g.name).sort(),
    ['10', '8', '9'],
  );
  assert.ok(!plan.gradesToAdd.some((g) => g.name === '6' || g.name === '7'));
  assert.deepEqual(plan.campusesToAdd, [{ name: 'OSMANPURACAMPUS', label: 'Osmanpura Campus', sortOrder: 12 }]);
  assert.ok(!plan.campusesToAdd.some((c) => c.name === 'CITYCAMPUS' || c.name === 'CITY' || c.name === 'AIRPORTCAMPUS'));
  assert.equal('divisionsToAdd' in plan, false); // divisions are the admin's
  const completeGrades = ['6', '7', '8', '9', '10'].map((n, i) => grade(`g${n}`, n, `Grade ${n}`, (i + 1) * 10, DIVS));
  const completeCampuses: MasterCampus[] = [
    { id: 'a', name: 'AIRPORTCAMPUS', label: 'Airport Campus', sortOrder: 10, active: true },
    { id: 'c', name: 'CITYCAMPUS', label: 'City Campus', sortOrder: 20, active: true },
    { id: 'o', name: 'OSMANPURACAMPUS', label: 'Osmanpura Campus', sortOrder: 30, active: true },
  ];
  const empty = planJoinAudience(completeGrades, completeCampuses);
  assert.equal(planAddsAnything(empty), false);

  // Inactive rows are not re-created.
  const inactive = planJoinAudience(
    [grade('g8', '8', 'Grade 8', 80, DIVS, false)],
    [{ id: 'o', name: 'OSMANPURACAMPUS', label: 'Osmanpura Campus', sortOrder: 30, active: false }],
  );
  assert.ok(!inactive.gradesToAdd.some((g) => g.name === '8'));
  assert.ok(!inactive.campusesToAdd.some((c) => c.name === 'OSMANPURACAMPUS'));
});

test('checkNames: trimmed first and last, letters only, length limit', () => {
  assert.deepEqual(checkNames('  asha  ', '  patil '), { firstName: 'asha', lastName: 'patil', name: 'asha patil' });
  assert.deepEqual(checkNames("D'Souza", 'Ann-Marie'), { firstName: "D'Souza", lastName: 'Ann-Marie', name: "D'Souza Ann-Marie" });
  assert.deepEqual(checkNames('आशा', 'पाटील'), { firstName: 'आशा', lastName: 'पाटील', name: 'आशा पाटील' });
  assert.deepEqual(checkNames('Asha', 'Kumar Patil'), { firstName: 'Asha', lastName: 'Kumar Patil', name: 'Asha Kumar Patil' });
  assert.equal((checkNames('', 'Patil') as { field: string }).field, 'firstName');
  assert.equal((checkNames('Asha', '  ') as { field: string }).field, 'lastName');
  assert.ok('error' in checkNames('Asha', '123'));
  assert.ok('error' in checkNames('<b>Asha</b>', 'P'));
  assert.ok('error' in checkNames('A'.repeat(51), 'Patil'));
  assert.ok('error' in checkNames('Asha', 'B'.repeat(51)));
  assert.ok('error' in checkNames(42, 'Patil'));
});

test('name matching ignores case, accents and spacing; derived IDs are stable', () => {
  assert.equal(nameKey('  ÁSHA   Patil '), nameKey('asha patil'));
  assert.equal(formStudentId(CLS, 'Asha Patil'), formStudentId(CLS, 'asha  PATIL'));
  assert.notEqual(formStudentId(CLS, 'Asha Patil'), formStudentId(CLS, 'Asha Pati'));
  assert.notEqual(formStudentId(CLS, 'Asha Patil'), formStudentId({ ...CLS, division: 'B' }, 'Asha Patil'));
  assert.match(formStudentId(CLS, 'Asha Patil'), /^WEB-[0-9a-f]{20}$/);
});

test('pickStudentId reuses the one record on file, refuses duplicates, else derives', () => {
  const onFile: OnFile[] = [
    { externalId: 'GOS001', name: 'Asha Patil' },
    { externalId: 'GOS002', name: 'Rahul Shah' },
    { externalId: 'GOS003', name: 'rahul  SHAH' },
  ];
  assert.deepEqual(pickStudentId(CLS, 'ASHA patil', onFile), { sid: 'GOS001' });
  assert.deepEqual(pickStudentId(CLS, 'Rahul Shah', onFile), { error: 'ambiguous' });
  assert.deepEqual(pickStudentId(CLS, 'Meera Iyer', onFile), { sid: formStudentId(CLS, 'Meera Iyer') });
});

test('splitName', () => {
  assert.deepEqual(splitName('Asha Kumar Patil'), { firstName: 'Asha', lastName: 'Kumar Patil' });
});

function deps(over: Partial<JoinFormDeps> = {}) {
  const calls: { claims: JoinClaims; signed: boolean }[] = [];
  const d: JoinFormDeps = {
    mode: 'unsigned',
    grades: async () => GRADES,
    campuses: async () => CAMPUSES,
    onFile: async () => [{ externalId: 'GOS001', name: 'Asha Patil' }],
    finish: async (claims, signed) => {
      calls.push({ claims, signed });
    },
    ...over,
  };
  return { d, calls };
}
const body = async (r: Response) => ({ status: r.status, ...(await r.json()) });

test('handleJoinForm: uses the chosen class; unknown or missing class is refused', async () => {
  const { d, calls } = deps();
  const r = await body(
    await handleJoinForm(
      { firstName: ' Meera  ', lastName: ' Iyer ', grade: '6', campus: 'CITY', division: 'A', sid: 'HACK' },
      d,
    ),
  );
  assert.deepEqual(r, { status: 200, ok: true, redirect: '/student' });
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.signed, false);
  assert.equal(c.claims.grade, '6');
  assert.equal(c.claims.campus, 'CITY');
  assert.equal(c.claims.division, 'A');
  assert.equal(c.claims.name, 'Meera Iyer');
  assert.equal(c.claims.studentId, formStudentId({ campus: 'CITY', grade: '6', division: 'A' }, 'Meera Iyer'));

  const missing = await body(await handleJoinForm({ firstName: 'Meera', lastName: 'Iyer' }, deps().d));
  assert.equal(missing.status, 400);
  assert.equal(missing.error, PICK_CLASS);

  const unknown = await body(
    await handleJoinForm({ firstName: 'Meera', lastName: 'Iyer', grade: '7', campus: 'AIRPORTCAMPUS', division: 'Z' }, deps().d),
  );
  assert.equal(unknown.status, 400);
  assert.equal(unknown.error, UNKNOWN_CLASS);

  const spoof = await body(
    await handleJoinForm({ firstName: 'Meera', lastName: 'Iyer', grade: '7', campus: 'AIRPORTCAMPUS', foundation: 'B' }, deps().d),
  );
  // Older pages sent the division as `foundation`: still accepted.
  assert.equal(spoof.status, 200);
  assert.equal(spoof.ok, true);
});

test('handleJoinForm: a student on file keeps their record (attendance lands on it)', async () => {
  const { d, calls } = deps();
  await handleJoinForm({ firstName: 'asha', lastName: 'patil', grade: '7', campus: 'Airport Campus', division: 'A' }, d);
  assert.equal(calls[0]!.claims.studentId, 'GOS001');
  assert.equal(calls[0]!.claims.campus, 'AIRPORTCAMPUS');
});

test('handleJoinForm: friendly errors', async () => {
  let r = await body(await handleJoinForm({ firstName: 'Asha' }, deps().d));
  assert.equal(r.status, 400);
  assert.equal(r.field, 'lastName');
  r = await body(await handleJoinForm(null, deps().d));
  assert.equal(r.status, 400);
  r = await body(
    await handleJoinForm(
      { firstName: 'Asha', lastName: 'Patil', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ campuses: async () => [CAMPUSES[0]!] }).d,
    ),
  );
  assert.deepEqual([r.status, r.error], [400, UNKNOWN_CLASS]);
  r = await body(
    await handleJoinForm(
      { firstName: 'Asha', lastName: 'Patil', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ grades: async () => [], campuses: async () => [] }).d,
    ),
  );
  assert.deepEqual([r.status, r.error], [503, NOT_AVAILABLE]);
  r = await body(
    await handleJoinForm(
      { firstName: 'Rahul', lastName: 'Shah', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ onFile: async () => [{ externalId: 'a', name: 'Rahul Shah' }, { externalId: 'b', name: 'Rahul Shah' }] }).d,
    ),
  );
  assert.equal(r.status, 409);
  assert.match(r.error, /ask your teacher/);
  r = await body(
    await handleJoinForm(
      { firstName: 'Asha', lastName: 'Patil', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ mode: 'signed' }).d,
    ),
  );
  assert.equal(r.status, 403);
  r = await body(
    await handleJoinForm(
      { firstName: 'Asha', lastName: 'Patil', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ limited: async () => true }).d,
    ),
  );
  assert.equal(r.status, 429);
  r = await body(
    await handleJoinForm(
      { firstName: 'New', lastName: 'Person', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ finish: async () => { throw new JoinTokenError('unknown_student', 'sid'); } }).d,
    ),
  );
  assert.equal(r.status, 404);
  assert.match(r.error, /school list/);
  r = await body(
    await handleJoinForm(
      { firstName: 'Asha', lastName: 'Patil', grade: '7', campus: 'Airport Campus', division: 'A' },
      deps({ grades: async () => { throw new Error('db down'); } }).d,
    ),
  );
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.error, /db down/);
});

test('feature stays self-contained: ALLOW_NAME_JOIN toggle, homepage button, form page, endpoint', () => {
  const root = new URL('../src/', import.meta.url);
  const home = readFileSync(new URL('app/page.tsx', root), 'utf8');
  assert.match(home, /href="\/join-class"[\s\S]*Join the class/);
  // One switch turns the whole feature off (SEC-02): button, page and API.
  assert.match(home, /nameJoin && \(/);
  assert.ok(existsSync(new URL('app/join-class/page.tsx', root)));
  assert.ok(existsSync(new URL('app/api/join-class/route.ts', root)));
  assert.ok(existsSync(new URL('lib/joinClassSeed.ts', root)));
  const form = readFileSync(new URL('components/joinClass/JoinClassForm.tsx', root), 'utf8');
  assert.match(form, /localStorage/);
  assert.match(form, /<select/);
  // Client form may type-import the lib, but must not import values (node:crypto breaks the webpack build).
  assert.match(form, /import type \{[^}]*\} from '@\/lib\/joinClassForm'/);
  assert.doesNotMatch(form, /import \{[^}]*\} from '@\/lib\/joinClassForm'/);
  // Nov 27: no foundation; name, then campus, grade, division in that order.
  assert.doesNotMatch(form, /[Ff]oundation/);
  assert.match(form, /join-first-name/);
  assert.match(form, /join-last-name/);
  assert.ok(form.indexOf('id="join-campus"') < form.indexOf('id="join-grade"'));
  assert.ok(form.indexOf('id="join-grade"') < form.indexOf('id="join-division"'));
  assert.match(form, /label="Division"/);
  assert.match(form, /Select grade/);
  assert.match(form, /Select campus/);
  assert.match(form, /'Select division'/);
  assert.doesNotMatch(form, /join-name"/);
  assert.match(form, /disabled=\{busy \|\| !ready\}/);
  const lib = readFileSync(new URL('lib/joinClassForm.ts', root), 'utf8');
  assert.doesNotMatch(lib, /process\.env/);
  // The school-app link and the form share the same finishing step.
  const link = readFileSync(new URL('app/api/student/join/route.ts', root), 'utf8');
  const api = readFileSync(new URL('app/api/join-class/route.ts', root), 'utf8');
  assert.match(link, /finishStudentJoin\(claims, signed\)/);
  // Same finishing step, behind the per-class cap on new names (SEC-03).
  assert.match(api, /finish: finishWithNewNameCap/);
  assert.match(api, /await finishStudentJoin\(claims, signed\)/);
  assert.match(api, /if \(!nameJoinAllowedFromEnv\(\)\) return jsonError/);
  const page = readFileSync(new URL('app/join-class/page.tsx', root), 'utf8');
  assert.match(page, /ensureJoinAudience/);
  assert.match(page, /if \(!nameJoinAllowedFromEnv\(\)\) notFound\(\)/);
  const inst = readFileSync(new URL('instrumentation.ts', root), 'utf8');
  assert.match(inst, /ensureJoinAudience/);
});

test('nameKey keeps Indic vowel signs (different names stay different)', () => {
  assert.notEqual(nameKey('आशा पाटील'), nameKey('आश पटल'));
  assert.equal(nameKey(' आशा  पाटील '), nameKey('आशा पाटील'));
});
