import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audienceIncludes,
  audiencesOverlap,
  canTeachAudience,
  formatAssignment,
  normalizeDivision,
  normalizeGrade,
  parseAssignments,
} from '../src/lib/grades';

test('grade/division normalisation', () => {
  assert.equal(normalizeGrade(' Grade 7 '), '7');
  assert.equal(normalizeGrade('class 10'), '10');
  assert.equal(normalizeGrade('xii'), 'XII');
  assert.equal(normalizeDivision(' b '), 'B');
  assert.equal(normalizeDivision('all'), '*');
  assert.equal(normalizeDivision('Div A'), 'A');
});

test('parse admin assignment text', () => {
  assert.deepEqual(parseAssignments('7-A, 7-b; 8-ALL\n9 C, 10D, 7-A', 'cc'), [
    { campus: 'CC', grade: '7', division: 'A' },
    { campus: 'CC', grade: '7', division: 'B' },
    { campus: 'CC', grade: '8', division: '*' },
    { campus: 'CC', grade: '9', division: 'C' },
    { campus: 'CC', grade: '10', division: 'D' },
  ]);
  assert.deepEqual(parseAssignments('', 'CC'), []);
  assert.throws(() => parseAssignments('seven', 'CC'));
  // Per-token campus prefix (the picker/API format) and the missing-campus error.
  assert.deepEqual(parseAssignments('North@7-A, cc @ 8-all', ''), [
    { campus: 'NORTH', grade: '7', division: 'A' },
    { campus: 'CC', grade: '8', division: '*' },
  ]);
  assert.throws(() => parseAssignments('7-A', ''), /Pick a campus/);
  assert.equal(formatAssignment({ campus: 'CC', grade: '7', division: 'A' }), 'CC@7-A');
  assert.deepEqual(parseAssignments(formatAssignment({ campus: 'CC', grade: '7', division: 'MAHAVEER' }), ''), [
    { campus: 'CC', grade: '7', division: 'MAHAVEER' },
  ]);
});

test('ad-hoc classes are limited to the teacher’s assigned grades/divisions', () => {
  const mine = parseAssignments('7-A, 7-B, 8-ALL', 'CC');
  assert.equal(canTeachAudience(mine, 'CC', '7', ['A'], false), true);
  assert.equal(canTeachAudience(mine, 'CC', '7', ['A', 'B'], false), true);
  assert.equal(canTeachAudience(mine, 'CC', '7', ['C'], false), false, 'unassigned division');
  assert.equal(canTeachAudience(mine, 'CC', '7', ['A', 'C'], false), false, 'one unassigned division is enough to refuse');
  assert.equal(canTeachAudience(mine, 'CC', '7', [], true), false, 'all divisions of 7 includes 7-C');
  assert.equal(canTeachAudience(mine, 'CC', '8', ['Z'], false), true, '8-ALL covers any division');
  assert.equal(canTeachAudience(mine, 'CC', '8', [], true), true);
  assert.equal(canTeachAudience(mine, 'CC', '9', ['A'], false), false, 'unassigned grade');
  assert.equal(canTeachAudience(mine, 'CC', '7', [], false), false, 'no divisions picked');
  assert.equal(canTeachAudience([], 'CC', '7', ['A'], false), false);
  assert.equal(canTeachAudience(mine, 'NORTH', '7', ['A'], false), false, 'same grade on another campus');
});

test('audience membership and overlap (combined / ALL divisions)', () => {
  const combined = { campus: 'CC', grade: '7', divisions: ['A', 'B'], allDivisions: false };
  const all = { campus: 'CC', grade: '7', divisions: [] as string[], allDivisions: true };
  assert.equal(audienceIncludes(combined, { campus: 'cc', grade: '7', division: 'b' }), true);
  assert.equal(audienceIncludes(combined, { campus: 'cc', grade: '7', division: 'C' }), false);
  assert.equal(audienceIncludes(all, { campus: 'cc', grade: '7', division: 'Q' }), true);
  assert.equal(audienceIncludes(all, { campus: 'cc', grade: '8', division: 'A' }), false);
  assert.equal(audiencesOverlap(combined, { campus: 'CC', grade: '7', divisions: ['B'], allDivisions: false }), true);
  assert.equal(audiencesOverlap(combined, { campus: 'CC', grade: '7', divisions: ['C'], allDivisions: false }), false);
  assert.equal(audiencesOverlap(combined, all), true);
  assert.equal(audienceIncludes(all, { campus: 'NORTH', grade: '7', division: 'A' }), false, 'other campus');
  assert.equal(audiencesOverlap(combined, { ...all, campus: 'NORTH' }), false, 'other campus');
  assert.equal(audiencesOverlap(all, { campus: 'CC', grade: '8', divisions: [], allDivisions: true }), false);
});
