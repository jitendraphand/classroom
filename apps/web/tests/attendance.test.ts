import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyJoin, applyLeave, attendanceStatus, closeAll, emptyConn, isLate, lateThreshold, totalConnectedMs } from '../src/lib/attendance';

const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 3, 30) + min * 60_000);

test('attendance: sums connected time across reconnects', () => {
  let s = emptyConn();
  s = applyJoin(s, 'PA_1', t(0));
  s = applyLeave(s, 'PA_1', t(10));
  s = applyJoin(s, 'PA_2', t(15));
  s = applyLeave(s, 'PA_2', t(40));
  assert.equal(s.connectedMs, 35 * 60_000);
  assert.equal(s.connections, 2);
  assert.deepEqual(s.leftAt, t(40));
});

test('attendance: overlapping connections are not double counted', () => {
  let s = emptyConn();
  s = applyJoin(s, 'A', t(0));
  s = applyJoin(s, 'B', t(5)); // reconnect before A's "left" arrived
  s = applyLeave(s, 'A', t(6));
  assert.equal(s.connectedMs, 0, 'still connected via B');
  s = applyLeave(s, 'B', t(20));
  assert.equal(s.connectedMs, 20 * 60_000);
});

test('attendance: duplicate and unknown webhook events are ignored', () => {
  let s = emptyConn();
  s = applyJoin(s, 'A', t(0));
  s = applyJoin(s, 'A', t(3));
  s = applyLeave(s, 'X', t(4));
  s = applyLeave(s, 'A', t(10));
  s = applyLeave(s, 'A', t(12));
  assert.equal(s.connectedMs, 10 * 60_000);
  assert.equal(s.connections, 1);
});

test('attendance: closeAll and running totals', () => {
  let s = applyJoin(emptyConn(), 'A', t(0));
  assert.equal(totalConnectedMs(s, t(7)), 7 * 60_000);
  s = closeAll(s, t(30));
  assert.equal(s.connectedMs, 30 * 60_000);
  assert.equal(s.openSids.length, 0);
  assert.equal(closeAll(s, t(50)).connectedMs, 30 * 60_000);
});

test('attendance: late threshold uses later of scheduled and actual start plus grace', () => {
  const sched = { adHoc: false, scheduledStart: t(0), startedAt: t(-5) };
  assert.deepEqual(lateThreshold(sched, 5), t(5));
  assert.equal(isLate(t(4), sched, 5), false);
  assert.equal(isLate(t(6), sched, 5), true);
  // Teacher started 10 min late: students are not late because of that.
  const lateTeacher = { adHoc: false, scheduledStart: t(0), startedAt: t(10) };
  assert.equal(isLate(t(12), lateTeacher, 5), false);
  assert.equal(isLate(t(16), lateTeacher, 5), true);
  // Ad-hoc: from actual start.
  const adhoc = { adHoc: true, scheduledStart: null, startedAt: t(0) };
  assert.equal(isLate(t(6), adhoc, 5), true);
  // Not started yet and no schedule: never late.
  assert.equal(isLate(t(100), { adHoc: true, scheduledStart: null, startedAt: null }, 5), false);
});

test('attendance: status', () => {
  assert.equal(attendanceStatus(null), 'absent');
  assert.equal(attendanceStatus({ admittedAt: null, late: false }), 'not_admitted');
  assert.equal(attendanceStatus({ admittedAt: t(1), late: false }), 'present');
  assert.equal(attendanceStatus({ admittedAt: t(1), late: true }), 'late');
});
