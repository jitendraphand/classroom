import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageAttendance, sessionAttendance } from '../src/lib/sessionStats';

const cs = {
  campus: 'Main', grade: '5', divisions: ['A'], allDivisions: false,
  endedAt: new Date('2026-10-01T10:00:00Z'), scheduledEnd: null,
  attendance: [{ studentId: 's1', admittedAt: new Date() }, { studentId: 's2', admittedAt: null }],
};

test('average attendance is not blank when no stored student matches the audience', () => {
  const r = sessionAttendance(cs, []);
  assert.equal(r.ratio, 1);
  assert.equal(averageAttendance([r.ratio]), 1);
});

test('enrolled counts audience students and attendees once each', () => {
  const s = (id: string, division: string) => ({ id, campus: 'Main', grade: '5', division, createdAt: new Date(0), deletedAt: null });
  const r = sessionAttendance(cs, [s('s1', 'A'), s('s3', 'A'), s('s4', 'B')]);
  assert.deepEqual(r, { present: 1, enrolled: 2, ratio: 0.5 });
});
