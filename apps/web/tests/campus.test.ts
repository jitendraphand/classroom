import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCampusOptions, campusInput, campusProblem, missingCampuses, resolveJoinCampus } from '../src/lib/campusLogic';
import { audienceIncludes, audiencesOverlap, canTeachAudience, normalizeCampus, parseAssignments, formatAssignment } from '../src/lib/grades';
import { validateUnsignedJoin } from '../src/lib/schoolJoin';
import { readUnsignedFields } from '../src/lib/joinParams';

const cc = { id: '1', name: 'CC', label: 'CC', sortOrder: 10, active: true };
const north = { id: '2', name: 'NORTH', label: 'North', sortOrder: 20, active: true };

test('campus is case- and space-insensitive', () => {
  assert.equal(normalizeCampus(' c c '), 'CC');
  assert.equal(normalizeCampus('North Campus'), 'NORTHCAMPUS');
  assert.deepEqual(campusInput(' North  Campus '), { name: 'NORTHCAMPUS', label: 'North Campus' });
  assert.equal(campusInput('ALL'), null);
  assert.equal(campusInput(''), null);
});

test('join link Campus= is read and normalised', () => {
  const p = new URLSearchParams('FirstName=Aryan&LastName=Patil&SID=GOS000123&Grade=9&Division=Alpha&Campus=c c');
  const claims = validateUnsignedJoin(readUnsignedFields(p));
  assert.equal(claims.campus, 'CC');
  assert.equal(claims.division, 'ALPHA');
  const none = validateUnsignedJoin(readUnsignedFields(new URLSearchParams('FirstName=A&SID=X1&Grade=9&Division=A')));
  assert.equal(none.campus, null);
});

test('join without Campus: the only campus, else refused', () => {
  assert.equal(resolveJoinCampus('cc', [cc, north]), 'CC');
  assert.equal(resolveJoinCampus('', [cc]), 'CC');
  assert.equal(resolveJoinCampus(null, [cc, { ...north, active: false }]), 'CC');
  assert.equal(resolveJoinCampus(null, [cc, north]), null);
  assert.equal(resolveJoinCampus(undefined, []), null);
  // Unknown campus in the link is kept (school app is the source of truth).
  assert.equal(resolveJoinCampus('South', [cc]), 'SOUTH');
});

test('routing matches campus + grade + division', () => {
  const aud = { campus: 'CC', grade: '9', divisions: ['ALPHA'], allDivisions: false };
  assert.equal(audienceIncludes(aud, { campus: 'cc', grade: '9', division: 'alpha' }), true);
  assert.equal(audienceIncludes(aud, { campus: 'NORTH', grade: '9', division: 'ALPHA' }), false);
  assert.equal(audienceIncludes({ ...aud, allDivisions: true }, { campus: 'CC', grade: '9', division: 'Z' }), true);
  assert.equal(audienceIncludes({ ...aud, allDivisions: true }, { campus: 'NORTH', grade: '9', division: 'Z' }), false);
  assert.equal(audiencesOverlap(aud, { ...aud, campus: 'NORTH' }), false);
  assert.equal(audiencesOverlap(aud, { ...aud }), true);
});

test('teacher assignments carry campus', () => {
  const a = parseAssignments('9-A, NORTH@9-ALL', 'cc');
  assert.deepEqual(a, [
    { campus: 'CC', grade: '9', division: 'A' },
    { campus: 'NORTH', grade: '9', division: '*' },
  ]);
  assert.deepEqual(parseAssignments(a.map(formatAssignment).join(', '), 'X'), a);
  assert.equal(canTeachAudience(a, 'CC', '9', ['A'], false), true);
  assert.equal(canTeachAudience(a, 'NORTH', '9', ['A'], false), true);
  assert.equal(canTeachAudience(a, 'CC', '9', [], true), false);
  assert.equal(canTeachAudience(a, 'SOUTH', '9', ['A'], false), false);
  assert.throws(() => parseAssignments('9-A', ''));
});

test('campus master helpers', () => {
  assert.deepEqual(activeCampusOptions([north, cc, { ...cc, id: '3', name: 'OLD', active: false }]), [
    { name: 'CC', label: 'CC' },
    { name: 'NORTH', label: 'North' },
  ]);
  assert.equal(campusProblem([], 'X'), null);
  assert.equal(campusProblem([cc], ''), 'Pick a campus.');
  assert.match(campusProblem([cc], 'north')!, /NORTH is not in/);
  assert.deepEqual(missingCampuses(['cc', 'north', null, 'North'], [cc]), ['NORTH']);
});

test('roster: campus column, default campus for the file, unknown campus refused', async () => {
  const { parseRoster } = await import('../src/lib/roster');
  const csv = 'id,name,grade,division,campus\nS1,Asha,7,A,north\nS2,Ravi,7,B,\nS3,Meera,7,C,Mars\n';
  const r = parseRoster(csv, [], [cc, north], 'CC');
  assert.deepEqual(
    r.rows.map((x) => [x.externalId, x.campus]),
    [
      ['S1', 'NORTH'],
      ['S2', 'CC'],
    ]
  );
  assert.match(r.errors[0]!, /Line 4: .*MARS/);
  const none = parseRoster('id,name,grade,division\nS1,Asha,7,A\n', [], [cc, north], '');
  assert.match(none.errors[0]!, /missing campus/);
});

test('campus admin API: add, rename only while unused, delete only while unused', async () => {
  const { handleCreateCampus, handleUpdateCampus, handleDeleteCampus, handleListCampuses } = await import('../src/lib/campusApi');
  const rows = [{ ...cc }];
  const used: Record<string, number> = { CC: 3 };
  const usage = (n: string) => [{ what: 'student', count: used[n] ?? 0, examples: [] as string[] }];
  const store = {
    list: async () => rows.map((r) => ({ ...r })),
    usageCounts: async () => used,
    usage: async (n: string) => usage(n),
    create: async (d: { name: string; label: string; sortOrder: number }) => {
      const c = { id: String(rows.length + 1), active: true, ...d };
      rows.push(c);
      return c;
    },
    update: async (id: string, d: object) => {
      Object.assign(rows.find((r) => r.id === id)!, d);
    },
    remove: async (id: string) => {
      rows.splice(rows.findIndex((r) => r.id === id), 1);
    },
    unrecognised: async () => [],
  };
  const ok = async () => ({ admin: {} as never });
  const deps = { guard: ok, store };
  assert.equal((await handleCreateCampus({ label: 'North' }, deps)).status, 201);
  assert.equal((await handleCreateCampus({ label: 'north' }, deps)).status, 409, 'duplicate (case-insensitive)');
  assert.equal((await handleCreateCampus({ label: 'all' }, deps)).status, 400);
  // CC is in use: label may change, code may not; delete refused; deactivate allowed.
  assert.equal((await handleUpdateCampus('1', { label: 'Cc ' }, deps)).status, 200);
  assert.equal((await handleUpdateCampus('1', { label: 'City Centre' }, deps)).status, 409);
  assert.equal((await handleDeleteCampus('1', deps)).status, 409);
  assert.equal((await handleUpdateCampus('1', { active: false }, deps)).status, 200);
  assert.equal(rows[0]!.active, false);
  // NORTH is unused: rename and delete work.
  assert.equal((await handleUpdateCampus('2', { label: 'North Wing' }, deps)).status, 200);
  assert.equal(rows[1]!.name, 'NORTHWING');
  assert.equal((await handleDeleteCampus('2', deps)).status, 200);
  const list = (await (await handleListCampuses(deps)).json()) as { campuses: { name: string; usageCount: number }[] };
  assert.deepEqual(list.campuses.map((c) => [c.name, c.usageCount]), [['CC', 3]]);
  const denied = { guard: async () => ({ res: new Response('no', { status: 401 }) }), store };
  assert.equal((await handleCreateCampus({ label: 'X' }, denied)).status, 401);
});
