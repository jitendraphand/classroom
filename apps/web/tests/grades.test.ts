import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audienceIncludes,
  audiencesOverlap,
  canTeachAudience,
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
  assert.deepEqual(parseAssignments('7-A, 7-b; 8-ALL\n9 C, 10D, 7-A'), [
    { grade: '7', division: 'A' },
    { grade: '7', division: 'B' },
    { grade: '8', division: '*' },
    { grade: '9', division: 'C' },
    { grade: '10', division: 'D' },
  ]);
  assert.deepEqual(parseAssignments(''), []);
  assert.throws(() => parseAssignments('seven'));
});

test('ad-hoc classes are limited to the teacher’s assigned grades/divisions', () => {
  const mine = parseAssignments('7-A, 7-B, 8-ALL');
  assert.equal(canTeachAudience(mine, '7', ['A'], false), true);
  assert.equal(canTeachAudience(mine, '7', ['A', 'B'], false), true);
  assert.equal(canTeachAudience(mine, '7', ['C'], false), false, 'unassigned division');
  assert.equal(canTeachAudience(mine, '7', ['A', 'C'], false), false, 'one unassigned division is enough to refuse');
  assert.equal(canTeachAudience(mine, '7', [], true), false, 'all divisions of 7 includes 7-C');
  assert.equal(canTeachAudience(mine, '8', ['Z'], false), true, '8-ALL covers any division');
  assert.equal(canTeachAudience(mine, '8', [], true), true);
  assert.equal(canTeachAudience(mine, '9', ['A'], false), false, 'unassigned grade');
  assert.equal(canTeachAudience(mine, '7', [], false), false, 'no divisions picked');
  assert.equal(canTeachAudience([], '7', ['A'], false), false);
});

test('audience membership and overlap (combined / ALL divisions)', () => {
  const combined = { grade: '7', divisions: ['A', 'B'], allDivisions: false };
  const all = { grade: '7', divisions: [], allDivisions: true };
  assert.equal(audienceIncludes(combined, '7', 'b'), true);
  assert.equal(audienceIncludes(combined, '7', 'C'), false);
  assert.equal(audienceIncludes(all, '7', 'Q'), true);
  assert.equal(audienceIncludes(all, '8', 'A'), false);
  assert.equal(audiencesOverlap(combined, { grade: '7', divisions: ['B'], allDivisions: false }), true);
  assert.equal(audiencesOverlap(combined, { grade: '7', divisions: ['C'], allDivisions: false }), false);
  assert.equal(audiencesOverlap(combined, all), true);
  assert.equal(audiencesOverlap(all, { grade: '8', divisions: [], allDivisions: true }), false);
});
