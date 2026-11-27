import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUDIENCE_INPUT_LENGTH,
  MAX_CAMPUS_LENGTH,
  MAX_DIVISION_LENGTH,
  canTeachAudience,
  normalizeCampus,
  normalizeDivision,
  parseDivisionList,
} from '../src/lib/grades';
import { divisionInput, audienceProblem } from '../src/lib/gradeMasterLogic';
import { startClassSchema } from '../src/lib/teacherStartSchema';
import { overrideBody, slotBody } from '../src/lib/timetableAdmin';
import { validateUnsignedJoin } from '../src/lib/schoolJoin';
import { JOIN_CLASS_FIXED, formStudentId, resolveFixedClass } from '../src/lib/joinClassForm';

// Nov 22: "Start an extra class" for 7-Science Foundation failed with
// "String must contain at most 16 character(s)": the ad-hoc schema capped
// divisions at 16 while the master list stores SCIENCEFOUNDATION (17).

test('extra-class schema accepts a 17-letter division code', () => {
  const body = startClassSchema.parse({
    kind: 'adhoc',
    campus: 'AIRPORTCAMPUS',
    grade: '7',
    divisions: ['SCIENCEFOUNDATION'],
    subject: 'Physics',
    maxVisibleVideos: 6,
  });
  assert.equal(body.kind, 'adhoc');
  assert.deepEqual(body.kind === 'adhoc' && body.divisions, ['SCIENCEFOUNDATION']);
});

test('extra-class schema accepts every code the master list can store', () => {
  const longest = 'D'.repeat(MAX_DIVISION_LENGTH);
  assert.ok(divisionInput(longest), 'admin can create a max-length division');
  assert.equal(divisionInput('X'.repeat(80))!.name.length, MAX_DIVISION_LENGTH);
  const ok = startClassSchema.safeParse({
    kind: 'adhoc',
    campus: 'C'.repeat(MAX_CAMPUS_LENGTH),
    grade: 'Grade 7',
    divisions: [longest, 'Division Science Foundation'],
  });
  assert.ok(ok.success);
  const tooLong = startClassSchema.safeParse({ kind: 'adhoc', campus: 'C', grade: '7', divisions: ['X'.repeat(MAX_AUDIENCE_INPUT_LENGTH + 1)] });
  assert.equal(tooLong.success, false);
});

test('timetable slot and override schemas accept long division codes', () => {
  const slot = slotBody.safeParse({ campus: 'Airport Campus', grade: '7', divisions: ['SCIENCEFOUNDATION'] });
  assert.ok(slot.success || !slot.error.issues.some((i) => i.path.includes('divisions')));
  const ov = overrideBody.safeParse({ grade: '7', divisions: ['SCIENCEFOUNDATION'] });
  assert.ok(ov.success || !ov.error.issues.some((i) => i.path.includes('divisions')));
});

test('SCIENCEFOUNDATION survives normalisation, matching and assignment checks', () => {
  assert.equal(normalizeDivision('Science Foundation'), 'SCIENCEFOUNDATION');
  assert.equal(normalizeDivision('7-Science Foundation'.replace(/^7-/, '')), 'SCIENCEFOUNDATION');
  assert.equal(normalizeCampus('Airport Campus'), 'AIRPORTCAMPUS');
  assert.deepEqual(parseDivisionList(['Science Foundation']), { divisions: ['SCIENCEFOUNDATION'], allDivisions: false });
  const master = [{ name: '7', divisions: [{ name: 'SCIENCEFOUNDATION' }] }] as never;
  assert.equal(audienceProblem(master, '7', ['SCIENCEFOUNDATION'], false), null);
  const assignments = [{ campus: 'AIRPORTCAMPUS', grade: '7', division: 'SCIENCEFOUNDATION' }];
  assert.ok(canTeachAudience(assignments, 'AIRPORTCAMPUS', '7', ['SCIENCEFOUNDATION'], false));
});

test('student join paths accept long division names (older data)', () => {
  const c = validateUnsignedJoin({ sid: 'GROK-TEST-1', firstName: 'Asha', grade: '7', division: 'Science Foundation', campus: 'Airport Campus' });
  assert.equal(c.division, 'SCIENCEFOUNDATION');
  assert.equal(c.campus, 'AIRPORTCAMPUS');
  const grades = [{ name: '7', label: 'Grade 7', active: true, sortOrder: 0, divisions: [{ name: 'SCIENCEFOUNDATION', label: 'Science Foundation', active: true, sortOrder: 0 }] }] as never;
  const campuses = [{ name: 'AIRPORTCAMPUS', label: 'Airport Campus', active: true, sortOrder: 0 }] as never;
  const fixed = resolveFixedClass(grades, campuses, { ...JOIN_CLASS_FIXED, division: 'Science Foundation' });
  assert.ok(fixed);
  assert.equal(fixed.division, 'SCIENCEFOUNDATION');
  assert.match(formStudentId(fixed, 'Asha Patil'), /^WEB-[0-9a-f]{20}$/);
});
