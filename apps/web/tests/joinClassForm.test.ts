import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import type { MasterCampus } from '../src/lib/campusLogic';
import type { MasterGrade } from '../src/lib/gradeMasterLogic';
import type { JoinClaims } from '../src/lib/schoolJwt';
import { JoinTokenError } from '../src/lib/schoolJwt';
import {
  JOIN_CLASS_FIXED,
  NOT_AVAILABLE,
  campusKey,
  checkName,
  formStudentId,
  gradeKey,
  handleJoinForm,
  nameKey,
  pickStudentId,
  resolveFixedClass,
  splitName,
  type JoinFormDeps,
  type OnFile,
} from '../src/lib/joinClassForm';

const div = (name: string, label: string, active = true) => ({ id: name, name, label, active });
const GRADES: MasterGrade[] = [
  { id: 'g6', name: '6', label: '6', sortOrder: 10, active: true, divisions: [div('SCIENCEFOUNDATION', 'Science Foundation')] },
  {
    id: 'g7',
    name: '7',
    label: 'Grade 7',
    sortOrder: 20,
    active: true,
    divisions: [div('A', 'A'), div('SCIENCEFOUNDATION', 'Science Foundation'), div('MAHAVEER', 'Mahaveer')],
  },
];
const CAMPUSES: MasterCampus[] = [
  { id: 'c1', name: 'CITY', label: 'City Campus', sortOrder: 1, active: true },
  { id: 'c2', name: 'AIRPORTCAMPUS', label: 'Airport Campus', sortOrder: 2, active: true },
];
const CLS = resolveFixedClass(GRADES, CAMPUSES)!;

test('fixed class constant is Grade 7 / Airport Campus / Science Foundation', () => {
  assert.deepEqual({ ...JOIN_CLASS_FIXED }, { grade: '7', campus: 'Airport Campus', division: 'Science Foundation' });
});

test('grade and campus keys tolerate the usual spellings', () => {
  for (const g of ['7', '7th', 'Grade 7', 'class 7', ' 7TH ']) assert.equal(gradeKey(g), '7', g);
  assert.notEqual(gradeKey('17'), '7');
  for (const c of ['Airport Campus', 'AIRPORTCAMPUS', 'airport', 'Airport']) assert.equal(campusKey(c), 'AIRPORT', c);
  assert.notEqual(campusKey('City Campus'), 'AIRPORT');
});

test('resolveFixedClass finds the stored records and returns their exact names and labels', () => {
  assert.deepEqual(CLS, {
    campus: 'AIRPORTCAMPUS',
    campusLabel: 'Airport Campus',
    grade: '7',
    gradeLabel: 'Grade 7',
    division: 'SCIENCEFOUNDATION',
    divisionLabel: 'Science Foundation',
  });
  // Grade stored as "7TH", campus as "AIRPORT", division label in other case.
  const g7th: MasterGrade[] = [{ ...GRADES[1]!, name: '7TH', label: '7th', divisions: [div('SCIENCEFOUNDATION', 'SCIENCE FOUNDATION')] }];
  const air: MasterCampus[] = [{ id: 'x', name: 'AIRPORT', label: 'Airport', sortOrder: 1, active: true }];
  const r = resolveFixedClass(g7th, air)!;
  assert.equal(r.grade, '7TH');
  assert.equal(r.campus, 'AIRPORT');
  assert.equal(r.division, 'SCIENCEFOUNDATION');
});

test('resolveFixedClass is null when grade, campus or division is missing or inactive', () => {
  assert.equal(resolveFixedClass([], CAMPUSES), null);
  assert.equal(resolveFixedClass(GRADES, [CAMPUSES[0]!]), null);
  assert.equal(resolveFixedClass(GRADES, [{ ...CAMPUSES[1]!, active: false }]), null);
  assert.equal(resolveFixedClass([{ ...GRADES[1]!, divisions: [div('A', 'A')] }], CAMPUSES), null);
  assert.equal(resolveFixedClass([{ ...GRADES[1]!, divisions: [div('SCIENCEFOUNDATION', 'Science Foundation', false)] }], CAMPUSES), null);
  assert.equal(resolveFixedClass([{ ...GRADES[1]!, active: false }], CAMPUSES), null);
  // "Science" alone is not "Science Foundation" (exact match only).
  assert.equal(resolveFixedClass([{ ...GRADES[1]!, divisions: [div('SCIENCE', 'Science')] }], CAMPUSES), null);
});

test('checkName: trimmed, first name and surname, letters only, length limit', () => {
  assert.deepEqual(checkName('  asha   patil '), { name: 'asha patil' });
  assert.deepEqual(checkName("D'Souza Ann-Marie"), { name: "D'Souza Ann-Marie" });
  assert.deepEqual(checkName('आशा पाटील'), { name: 'आशा पाटील' });
  assert.ok('error' in checkName(''));
  assert.ok('error' in checkName('   '));
  assert.ok('error' in checkName('Asha'));
  assert.ok('error' in checkName('Asha 123'));
  assert.ok('error' in checkName('<b>Asha</b> P'));
  assert.ok('error' in checkName('A'.repeat(40) + ' ' + 'B'.repeat(30)));
  assert.ok('error' in checkName(42));
});

test('name matching ignores case, accents and spacing; derived IDs are stable', () => {
  assert.equal(nameKey('  ÁSHA   Patil '), nameKey('asha patil'));
  assert.equal(formStudentId(CLS, 'Asha Patil'), formStudentId(CLS, 'asha  PATIL'));
  assert.notEqual(formStudentId(CLS, 'Asha Patil'), formStudentId(CLS, 'Asha Pati'));
  assert.notEqual(formStudentId(CLS, 'Asha Patil'), formStudentId({ ...CLS, division: 'A' }, 'Asha Patil'));
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

test('handleJoinForm: fixed class enforced server-side, client grade/campus/division ignored', async () => {
  const { d, calls } = deps();
  const r = await body(
    await handleJoinForm({ name: ' Meera  Iyer ', grade: '9', campus: 'CITY', division: 'A', sid: 'HACK' }, d),
  );
  assert.deepEqual(r, { status: 200, ok: true, redirect: '/student' });
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.signed, false);
  assert.equal(c.claims.grade, '7');
  assert.equal(c.claims.campus, 'AIRPORTCAMPUS');
  assert.equal(c.claims.division, 'SCIENCEFOUNDATION');
  assert.equal(c.claims.name, 'Meera Iyer');
  assert.equal(c.claims.studentId, formStudentId(CLS, 'Meera Iyer'));
});

test('handleJoinForm: a student on file keeps their record (attendance lands on it)', async () => {
  const { d, calls } = deps();
  await handleJoinForm({ name: 'asha patil' }, d);
  assert.equal(calls[0]!.claims.studentId, 'GOS001');
});

test('handleJoinForm: friendly errors', async () => {
  let r = await body(await handleJoinForm({ name: 'Asha' }, deps().d));
  assert.equal(r.status, 400);
  assert.equal(r.field, 'name');
  r = await body(await handleJoinForm(null, deps().d));
  assert.equal(r.status, 400);
  r = await body(await handleJoinForm({ name: 'Asha Patil' }, deps({ campuses: async () => [CAMPUSES[0]!] }).d));
  assert.deepEqual([r.status, r.error], [503, NOT_AVAILABLE]);
  r = await body(
    await handleJoinForm(
      { name: 'Rahul Shah' },
      deps({ onFile: async () => [{ externalId: 'a', name: 'Rahul Shah' }, { externalId: 'b', name: 'Rahul Shah' }] }).d,
    ),
  );
  assert.equal(r.status, 409);
  assert.match(r.error, /ask your teacher/);
  r = await body(await handleJoinForm({ name: 'Asha Patil' }, deps({ mode: 'signed' }).d));
  assert.equal(r.status, 403);
  r = await body(await handleJoinForm({ name: 'Asha Patil' }, deps({ limited: async () => true }).d));
  assert.equal(r.status, 429);
  r = await body(
    await handleJoinForm(
      { name: 'New Person' },
      deps({ finish: async () => { throw new JoinTokenError('unknown_student', 'sid'); } }).d,
    ),
  );
  assert.equal(r.status, 404);
  assert.match(r.error, /school list/);
  r = await body(await handleJoinForm({ name: 'Asha Patil' }, deps({ grades: async () => { throw new Error('db down'); } }).d));
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.error, /db down/);
});

test('feature stays self-contained: no toggle, homepage button, form page, endpoint', () => {
  const root = new URL('../src/', import.meta.url);
  const home = readFileSync(new URL('app/page.tsx', root), 'utf8');
  assert.match(home, /href="\/join-class"[\s\S]*Join the class/);
  assert.ok(existsSync(new URL('app/join-class/page.tsx', root)));
  assert.ok(existsSync(new URL('app/api/join-class/route.ts', root)));
  const form = readFileSync(new URL('components/joinClass/JoinClassForm.tsx', root), 'utf8');
  assert.match(form, /localStorage/);
  assert.doesNotMatch(form, /<select/);
  const lib = readFileSync(new URL('lib/joinClassForm.ts', root), 'utf8');
  assert.doesNotMatch(lib, /process\.env/);
  // The school-app link and the form share the same finishing step.
  const link = readFileSync(new URL('app/api/student/join/route.ts', root), 'utf8');
  const api = readFileSync(new URL('app/api/join-class/route.ts', root), 'utf8');
  assert.match(link, /finishStudentJoin\(claims, signed\)/);
  assert.match(api, /finish: finishStudentJoin/);
});

test('nameKey keeps Indic vowel signs (different names stay different)', () => {
  assert.notEqual(nameKey('आशा पाटील'), nameKey('आश पटल'));
  assert.equal(nameKey(' आशा  पाटील '), nameKey('आशा पाटील'));
});
