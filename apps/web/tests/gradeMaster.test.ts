import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdminGuard } from '../src/lib/adminLiveApi';
import {
  handleCreateDivision,
  handleCreateGrade,
  handleDeleteDivision,
  handleDeleteGrade,
  handleGradeOptions,
  handleListGrades,
  handleRecognise,
  handleReorder,
  handleSync,
  handleUpdateDivision,
  handleUpdateGrade,
  type GradeStore,
} from '../src/lib/gradeMasterApi';
import {
  activeOptions,
  assignmentsProblem,
  audienceProblem,
  collectMasterData,
  divisionInput,
  gradeInput,
  missingFromMaster,
  rosterAudienceProblem,
  teacherGradeChoices,
  unrecognisedFromStudents,
  type MasterGrade,
  type Usage,
} from '../src/lib/gradeMasterLogic';
import { parseRoster } from '../src/lib/roster';

const unauthorized: AdminGuard = async () => ({
  res: new Response(JSON.stringify({ error: 'Admin sign-in required' }), { status: 401 }),
});
const asAdmin: AdminGuard = async () => ({ admin: { id: 'adm1', name: 'Head', email: 'h@x.org' } });

/** In-memory GradeStore; `used` marks "grade" or "grade|division" as in use. */
function fakeStore(initial: MasterGrade[] = [], used: Record<string, number> = {}, sources: { grade: string; divisions?: string[] }[] = []) {
  const grades: MasterGrade[] = structuredClone(initial);
  let n = 0;
  const calls: string[] = [];
  const usage = (key: string): Usage => [{ what: 'timetable slot(s)', count: used[key] ?? 0, examples: used[key] ? ['Mon 09:00 Maths'] : [] }];
  const findDiv = (id: string) => {
    for (const g of grades) {
      const d = g.divisions.find((x) => x.id === id);
      if (d) return { g, d };
    }
    return null;
  };
  const store: GradeStore = {
    list: async () => structuredClone(grades),
    usageCounts: async () => {
      const g: Record<string, number> = {};
      const d: Record<string, number> = {};
      for (const [k, v] of Object.entries(used)) (k.includes('|') ? d : g)[k] = v;
      return { grades: g, divisions: d };
    },
    gradeUsage: async (name) => usage(name),
    divisionUsage: async (g, d) => usage(`${g}|${d}`),
    getGrade: async (id) => {
      const g = grades.find((x) => x.id === id);
      return g ? { id: g.id, name: g.name, label: g.label, sortOrder: g.sortOrder, active: g.active } : null;
    },
    getDivision: async (id) => {
      const f = findDiv(id);
      return f ? { ...f.d, gradeId: f.g.id, gradeName: f.g.name } : null;
    },
    createGrade: async (d) => {
      calls.push(`createGrade:${d.name}`);
      const g = { id: `g${++n}`, active: true, ...d, divisions: [] };
      grades.push(g);
      return { id: g.id, name: g.name, label: g.label, sortOrder: g.sortOrder, active: g.active };
    },
    updateGrade: async (id, d) => {
      calls.push(`updateGrade:${id}:${JSON.stringify(d)}`);
      Object.assign(grades.find((x) => x.id === id)!, d);
    },
    deleteGrade: async (id) => {
      calls.push(`deleteGrade:${id}`);
      grades.splice(grades.findIndex((x) => x.id === id), 1);
    },
    createDivision: async (gradeId, d) => {
      calls.push(`createDivision:${d.name}`);
      const g = grades.find((x) => x.id === gradeId)!;
      const row = { id: `d${++n}`, active: true, ...d };
      g.divisions.push(row);
      return { ...row, gradeId, gradeName: g.name };
    },
    updateDivision: async (id, d) => {
      calls.push(`updateDivision:${id}:${JSON.stringify(d)}`);
      Object.assign(findDiv(id)!.d, d);
    },
    deleteDivision: async (id) => {
      calls.push(`deleteDivision:${id}`);
      const f = findDiv(id)!;
      f.g.divisions.splice(f.g.divisions.indexOf(f.d), 1);
    },
    reorder: async (ids) => {
      calls.push(`reorder:${ids.join(',')}`);
      ids.forEach((id, i) => (grades.find((x) => x.id === id)!.sortOrder = (i + 1) * 10));
    },
    sources: async () => sources,
    studentGroups: async () => [
      { grade: '7', division: 'A', count: 30 },
      { grade: '7', division: 'Mahaveer', count: 4 },
      { grade: '11', division: 'B', count: 2 },
    ],
  };
  return { store, grades, calls };
}

const seven = (): MasterGrade => ({
  id: 'g7',
  name: '7',
  label: 'Grade 7',
  sortOrder: 10,
  active: true,
  divisions: [
    { id: 'd7a', name: 'A', label: 'A', active: true },
    { id: 'd7b', name: 'B', label: 'B', active: true },
    { id: 'd7c', name: 'C', label: 'C', active: false },
  ],
});
const eight = (): MasterGrade => ({ id: 'g8', name: '8', label: '8', sortOrder: 20, active: false, divisions: [{ id: 'd8a', name: 'A', label: 'A', active: true }] });

// ---------------------------------------------------------------- CRUD auth

test('every admin grade/division endpoint returns 401 without an admin session and touches nothing', async () => {
  const { store, calls } = fakeStore([seven()]);
  const deps = { guard: unauthorized, store };
  const results = await Promise.all([
    handleListGrades(deps),
    handleCreateGrade({ label: '9' }, deps),
    handleUpdateGrade('g7', { label: 'Seven' }, deps),
    handleDeleteGrade('g7', deps),
    handleCreateDivision('g7', { name: 'D' }, deps),
    handleUpdateDivision('d7a', { active: false }, deps),
    handleDeleteDivision('d7a', deps),
    handleReorder({ ids: ['g7'] }, deps),
    handleSync(deps),
    handleRecognise({ grade: '7', division: 'Z' }, deps),
  ]);
  for (const r of results) assert.equal(r.status, 401);
  assert.deepEqual(calls, []);
});

test('admin: create grade (canonical name, label kept, appended order) with divisions; duplicates rejected', async () => {
  const { store, grades } = fakeStore([seven()]);
  const deps = { guard: asAdmin, store };
  const r = await handleCreateGrade({ label: ' kg ', divisions: 'Mahaveer, rani  laxmi, ALL, A' }, deps);
  assert.equal(r.status, 201);
  const kg = grades.find((g) => g.name === 'KG')!;
  assert.equal(kg.label, 'kg');
  assert.equal(kg.sortOrder, 20);
  assert.deepEqual(kg.divisions.map((d) => [d.name, d.label]), [
    ['MAHAVEER', 'Mahaveer'],
    ['RANILAXMI', 'rani laxmi'],
    ['A', 'A'],
  ]);
  assert.equal((await handleCreateGrade({ label: 'Grade 7' }, deps)).status, 409);
  assert.equal((await handleCreateGrade({ label: '' }, deps)).status, 400);
  const dup = await handleCreateDivision('g7', { name: 'a' }, deps);
  assert.equal(dup.status, 409);
  const ok = await handleCreateDivision('g7', { name: 'd, Shivaji' }, deps);
  assert.equal(ok.status, 201);
  assert.deepEqual(grades[0]!.divisions.map((d) => d.name), ['A', 'B', 'C', 'D', 'SHIVAJI']);
  assert.equal((await handleCreateDivision('g7', { name: 'all' }, deps)).status, 400);
});

// ---------------------------------------------------------------- in-use rules

test('delete is blocked (409 + usage + deactivate suggestion) while in use; allowed once unused', async () => {
  const { store, grades, calls } = fakeStore([seven(), eight()], { '7': 3, '7|A': 2 });
  const deps = { guard: asAdmin, store };
  const g = await handleDeleteGrade('g7', deps);
  assert.equal(g.status, 409);
  const body = await g.json();
  assert.equal(body.suggest, 'deactivate');
  assert.match(body.error, /in use.*3 timetable slot\(s\) \(Mon 09:00 Maths\).*Deactivate it instead/);
  assert.equal(body.usage[0].count, 3);

  const d = await handleDeleteDivision('d7a', deps);
  assert.equal(d.status, 409);
  assert.equal((await d.json()).suggest, 'deactivate');
  assert.ok(!calls.some((c) => c.startsWith('delete')));

  assert.equal((await handleDeleteDivision('d7b', deps)).status, 200); // unused division of a used grade
  assert.equal((await handleDeleteGrade('g8', deps)).status, 200); // unused grade
  assert.deepEqual(grades.map((x) => x.id), ['g7']);
  assert.equal((await handleDeleteGrade('nope', deps)).status, 404);
});

test('rename: label always; canonical name only when unused; deactivate always allowed', async () => {
  const { store, grades } = fakeStore([seven(), eight()], { '7': 3, '7|A': 2 });
  const deps = { guard: asAdmin, store };
  assert.equal((await handleUpdateGrade('g7', { label: 'grade 7' }, deps)).status, 200); // same canonical "7"
  assert.equal(grades[0]!.label, 'grade 7');
  const blocked = await handleUpdateGrade('g7', { label: 'VII' }, deps);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /only its display label can change/);
  assert.equal((await handleUpdateGrade('g8', { label: 'VIII' }, deps)).status, 200);
  assert.equal(grades[1]!.name, 'VIII');
  assert.equal((await handleUpdateGrade('g8', { label: '7' }, deps)).status, 409); // clash
  assert.equal((await handleUpdateDivision('d7a', { label: 'Z' }, deps)).status, 409);
  assert.equal((await handleUpdateDivision('d7a', { label: 'a' }, deps)).status, 200);
  assert.equal(grades[0]!.divisions[0]!.label, 'a');
  assert.equal((await handleUpdateDivision('d7b', { label: 'Mahaveer' }, deps)).status, 200);
  assert.equal(grades[0]!.divisions[1]!.name, 'MAHAVEER');
  assert.equal((await handleUpdateDivision('d7b', { label: 'C' }, deps)).status, 409); // sibling exists
  assert.equal((await handleUpdateGrade('g7', { active: false }, deps)).status, 200);
  assert.equal(grades[0]!.active, false);
  assert.equal((await handleUpdateDivision('d7a', { active: false }, deps)).status, 200);
});

test('reorder validates ids and renumbers', async () => {
  const { store, grades } = fakeStore([seven(), eight()]);
  const deps = { guard: asAdmin, store };
  assert.equal((await handleReorder({ ids: ['g8', 'x'] }, deps)).status, 400);
  assert.equal((await handleReorder({ ids: ['g8', 'g8'] }, deps)).status, 400);
  assert.equal((await handleReorder({ ids: ['g8', 'g7'] }, deps)).status, 200);
  assert.deepEqual(grades.map((g) => [g.id, g.sortOrder]), [
    ['g7', 20],
    ['g8', 10],
  ]);
});

// ---------------------------------------------------------------- list / unrecognised / recognise

test('admin list: ordered, usage counts, unrecognised student entries', async () => {
  const { store } = fakeStore([eight(), seven()], { '7': 5, '7|A': 4 });
  const r = await handleListGrades({ guard: asAdmin, store });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.grades.map((g: { name: string }) => g.name), ['7', '8']);
  assert.equal(body.grades[0].usageCount, 5);
  assert.equal(body.grades[0].divisions[0].usageCount, 4);
  assert.deepEqual(body.unrecognised, [
    { grade: '7', division: 'MAHAVEER', count: 4, gradeKnown: true },
    { grade: '11', division: 'B', count: 2, gradeKnown: false },
  ]);
});

test('recognise: one-click add creates the grade/division (or re-activates)', async () => {
  const { store, grades } = fakeStore([seven(), eight()]);
  const deps = { guard: asAdmin, store };
  assert.equal((await handleRecognise({ grade: '11', division: 'b' }, deps)).status, 201);
  const g11 = grades.find((g) => g.name === '11')!;
  assert.deepEqual(g11.divisions.map((d) => d.name), ['B']);
  await handleRecognise({ grade: '7', division: 'mahaveer' }, deps);
  assert.ok(grades[0]!.divisions.some((d) => d.name === 'MAHAVEER' && d.label === 'Mahaveer'));
  await handleRecognise({ grade: '8', division: 'A' }, deps); // inactive grade → activated
  assert.equal(grades[1]!.active, true);
  await handleRecognise({ grade: '7', division: 'C' }, deps); // inactive division → activated
  assert.equal(grades[0]!.divisions.find((d) => d.name === 'C')!.active, true);
  assert.equal((await handleRecognise({ grade: '7', division: 'ALL' }, deps)).status, 400);
});

// ---------------------------------------------------------------- backfill

test('collectMasterData mirrors the migration backfill', () => {
  const out = collectMasterData([
    { grade: '7', divisions: ['A'] }, // teacher assignment
    { grade: '8', divisions: ['*'] }, // whole-grade assignment: grade only
    { grade: '7', divisions: ['B', 'a'] }, // slot
    { grade: '9', divisions: [] }, // all-divisions slot
    { grade: '10', divisions: ['Mahaveer'] }, // student
    { grade: 'KG', divisions: ['Rani Laxmi'] },
    { grade: null, divisions: ['X'] }, // CANCEL override: ignored
    { grade: ' ', divisions: ['Y'] },
  ]);
  assert.deepEqual(out, [
    { name: '7', divisions: ['A', 'B'] },
    { name: '8', divisions: [] },
    { name: '9', divisions: [] },
    { name: '10', divisions: ['MAHAVEER'] },
    { name: 'KG', divisions: ['RANILAXMI'] },
  ]);
  assert.deepEqual(missingFromMaster(out, [seven()]), [
    { name: '8', divisions: [] },
    { name: '9', divisions: [] },
    { name: '10', divisions: ['MAHAVEER'] },
    { name: 'KG', divisions: ['RANILAXMI'] },
  ]);
});

test('sync adds only what is missing and is idempotent', async () => {
  const { store, grades } = fakeStore([seven()], {}, [
    { grade: '7', divisions: ['A', 'D'] },
    { grade: '10', divisions: ['Mahaveer'] },
  ]);
  const deps = { guard: asAdmin, store };
  const r1 = await (await handleSync(deps)).json();
  assert.deepEqual(r1.added, { grades: 1, divisions: 2 });
  assert.deepEqual(grades[0]!.divisions.map((d) => d.name), ['A', 'B', 'C', 'D']);
  assert.deepEqual(grades[1]!.divisions.map((d) => [d.name, d.label]), [['MAHAVEER', 'Mahaveer']]);
  const r2 = await (await handleSync(deps)).json();
  assert.deepEqual(r2.added, { grades: 0, divisions: 0 });
});

// ---------------------------------------------------------------- dropdown data

test('options endpoint: needs admin/teacher session; returns active entries only, ordered', async () => {
  const list = async () => [eight(), { ...seven(), sortOrder: 30 }, { id: 'gk', name: 'KG', label: 'KG', sortOrder: 5, active: true, divisions: [] }];
  const denied = await handleGradeOptions({ authorised: async () => false, list });
  assert.equal(denied.status, 401);
  const r = await handleGradeOptions({ authorised: async () => true, list });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const body = await r.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.grades, [
    { name: 'KG', label: 'KG', divisions: [] },
    { name: '7', label: 'Grade 7', divisions: [{ name: 'A', label: 'A' }, { name: 'B', label: 'B' }] },
  ]);
  const empty = await (await handleGradeOptions({ authorised: async () => true, list: async () => [] })).json();
  assert.deepEqual(empty, { grades: [], configured: false });
  assert.deepEqual(activeOptions([eight()]), []);
});

// ---------------------------------------------------------------- validation helpers

test('input cleaning and audience validation (empty master list accepts anything)', () => {
  assert.deepEqual(gradeInput('Grade 7'), { name: '7', label: 'Grade 7' });
  assert.equal(gradeInput('7/A'), null);
  assert.deepEqual(divisionInput('Div A'), { name: 'A', label: 'A' });
  assert.deepEqual(divisionInput('mahaveer'), { name: 'MAHAVEER', label: 'mahaveer' });
  assert.equal(divisionInput('*'), null);
  assert.equal(divisionInput('A.1'), null);

  const m = [seven()];
  assert.equal(audienceProblem([], '99', ['Q'], false), null);
  assert.equal(audienceProblem(m, '7', ['a', 'B'], false), null);
  assert.equal(audienceProblem(m, '7', ['C'], false), null); // inactive still known (existing rows)
  assert.equal(audienceProblem(m, '7', [], true), null);
  assert.match(audienceProblem(m, '9', [], true)!, /Grade 9 is not in Grades & divisions/);
  assert.match(audienceProblem(m, '7', ['Z'], false)!, /Division Z of grade 7/);

  assert.equal(assignmentsProblem(m, [{ grade: '7', division: 'A' }, { grade: '7', division: '*' }]), null);
  assert.match(assignmentsProblem(m, [{ grade: '9', division: 'A' }])!, /Grade 9/);
  assert.equal(assignmentsProblem(m, [{ grade: '9', division: 'A' }], [{ grade: '9', division: 'A' }]), null); // already held

  assert.equal(rosterAudienceProblem([], '9', 'Q'), null);
  assert.equal(rosterAudienceProblem(m, '7', 'A'), null);
  assert.match(rosterAudienceProblem(m, '7', 'C')!, /not an active division/);
  assert.match(rosterAudienceProblem([eight()], '8', 'A')!, /not an active grade/);
});

test('roster import validates grade/division against the active master list', () => {
  const csv = 'externalId,name,grade,division\nS1,Asha,7,a\nS2,Ravi,7,C\nS3,Meera,9,A\nS4,Om,grade 7,b';
  const strict = parseRoster(csv, [seven()]);
  assert.deepEqual(strict.rows.map((r) => r.externalId), ['S1', 'S4']);
  assert.equal(strict.errors.length, 2);
  assert.match(strict.errors[0]!, /Line 3: division C is not an active division of grade 7/);
  assert.match(strict.errors[1]!, /Line 4: grade 9 is not an active grade/);
  assert.equal(parseRoster(csv).rows.length, 4); // master list not set up yet
});

test('teacher ad-hoc choices: assigned grades only, active master divisions for whole-grade', () => {
  const master = [seven(), eight(), { id: 'g9', name: '9', label: '9', sortOrder: 5, active: true, divisions: [{ id: 'x', name: 'Q', label: 'Q', active: true }] }];
  const choices = teacherGradeChoices(
    [
      { grade: '7', division: '*' },
      { grade: '8', division: 'A' }, // inactive grade → hidden
      { grade: '10', division: 'B' }, // not in master (legacy) → kept as assigned
    ],
    master
  );
  assert.deepEqual(choices, [
    { grade: '7', label: 'Grade 7', whole: true, divisions: [{ name: 'A', label: 'A' }, { name: 'B', label: 'B' }] },
    { grade: '10', label: '10', whole: false, divisions: [{ name: 'B', label: 'B' }] },
  ]);
  const specific = teacherGradeChoices([{ grade: '7', division: 'C' }, { grade: '7', division: 'A' }], master);
  assert.deepEqual(specific[0]!.divisions, [{ name: 'A', label: 'A' }]); // C inactive
  assert.deepEqual(teacherGradeChoices([{ grade: '7', division: '*' }], [])[0]!.divisions, []);
});

test('unrecognised list ignores known (incl. inactive) entries', () => {
  const out = unrecognisedFromStudents(
    [
      { grade: '7', division: 'c', count: 1 },
      { grade: '7', division: 'E', count: 2 },
    ],
    [seven()]
  );
  assert.deepEqual(out, [{ grade: '7', division: 'E', count: 2, gradeKnown: true }]);
});
