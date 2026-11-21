import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naturalCompare, naturalSortBy } from '../src/lib/naturalSort';
import { sortRoster } from '../src/lib/classSlots';
import { summariseByStudent, type DetailRow } from '../src/lib/reports';
import { parseHolders } from '../src/lib/drawLogic';
import { formatAudience } from '../src/lib/grades';
import { divisionInput } from '../src/lib/gradeMasterLogic';

const names = ['GROK-TEST Student 10', 'GROK-TEST Student 2', 'grok-test student 1', 'GROK-TEST Student 21', 'GROK-TEST Student 3'];

test('natural sort: Student 2 before Student 10, case-insensitive (Nov 7 trial)', () => {
  assert.deepEqual([...names].sort(naturalCompare), [
    'grok-test student 1',
    'GROK-TEST Student 2',
    'GROK-TEST Student 3',
    'GROK-TEST Student 10',
    'GROK-TEST Student 21',
  ]);
  assert.ok(naturalCompare('Roll 9', 'Roll 10') < 0);
  assert.equal(naturalCompare(null, ''), 0);
  // Deterministic tie-break for names equal under the collator.
  assert.ok(naturalCompare('ana', 'Ana') !== 0);
  assert.deepEqual(naturalSortBy([{ n: 'b10' }, { n: 'b9' }], (x) => x.n).map((x) => x.n), ['b9', 'b10']);
});

test('teacher roster sorts students naturally after hands / draw requests', () => {
  const people = names.map((displayName, i) => ({ id: `s${i}`, displayName, role: 'STUDENT' }));
  const out = sortRoster([...people, { id: 't', displayName: 'Teacher', role: 'TEACHER' }]);
  assert.deepEqual(out.map((p) => p.displayName), ['Teacher', 'grok-test student 1', 'GROK-TEST Student 2', 'GROK-TEST Student 3', 'GROK-TEST Student 10', 'GROK-TEST Student 21']);
});

test('per-student attendance report sorts names (and roll numbers) naturally', () => {
  const row = (name: string, rollNumber = ''): DetailRow => ({
    sessionId: 's', date: '2026-11-07', subject: 'P', teacher: 'T', audience: 'a', studentId: name, externalId: name, name, rollNumber,
    gradeDivision: 'GROKTEST · GROK-TEST-7-GROKTESTA', status: 'present', statusLabel: 'Present', firstJoined: '', admitted: '', left: '', connectedMin: 1,
  });
  assert.deepEqual(summariseByStudent(names.map((n) => row(n))).map((r) => r.name), [
    'grok-test student 1', 'GROK-TEST Student 2', 'GROK-TEST Student 3', 'GROK-TEST Student 10', 'GROK-TEST Student 21',
  ]);
  assert.deepEqual(summariseByStudent([row('x', '10'), row('y', '9')]).map((r) => r.rollNumber), ['9', '10']);
});

test('draw holders with the same expiry sort naturally by name', () => {
  const until = Date.now() + 60_000;
  const raw = Object.fromEntries(
    ['Student 10', 'Student 2'].map((name, i) => [`p${i}`, JSON.stringify({ participantId: `p${i}`, identity: `student_${i}`, name, until })])
  );
  const { active } = parseHolders(raw, Date.now());
  assert.deepEqual(active.map((h) => h.name), ['Student 2', 'Student 10']);
});

test('division names display exactly as stored in the master list (no "Groktesta")', () => {
  assert.equal(formatAudience('GROKTEST', 'GROK-TEST-7', ['GROKTESTB'], false), 'GROKTEST · GROK-TEST-7-GROKTESTB');
  assert.deepEqual(divisionInput('GROKTESTA'), { name: 'GROKTESTA', label: 'GROKTESTA' });
  assert.deepEqual(divisionInput('Mahaveer'), { name: 'MAHAVEER', label: 'Mahaveer' }, 'typed casing is kept');
});
