/**
 * Direct entry (waiting room off): who comes straight in, who waits.
 * Rules in lib/admissionLogic.ts; wiring checked in the source.
 * DB-level behaviour: tests/integration/admission.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { directEntryAllowed, idsToAdmitOnToggle, seatOwnerKey, shouldAutoAdmit } from '../src/lib/admissionLogic';

const src = (p: string) => readFileSync(`src/${p}`, 'utf8');

test('direct entry admits a waiting student; never with the waiting room on or after the class', () => {
  const waiting = { role: 'STUDENT', status: 'WAITING' };
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: false }, waiting), true);
  assert.equal(shouldAutoAdmit({ status: 'WAITING', waitingRoomOn: false }, waiting), true);
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: true }, waiting), false);
  assert.equal(shouldAutoAdmit({ status: 'ENDED', waitingRoomOn: false }, waiting), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: false }, { role: 'STUDENT', status: 'ADMITTED' }), false);
});

test('earlier seats: Leave, drops and device switches allow direct entry; Deny / Remove do not', () => {
  assert.equal(directEntryAllowed([]), true); // first arrival (on time or late)
  assert.equal(directEntryAllowed([{ removedByTeacher: false }]), true); // pressed Leave
  assert.equal(directEntryAllowed([{ removedByTeacher: false }, { removedByTeacher: false }]), true);
  assert.equal(directEntryAllowed([{ removedByTeacher: true }]), false); // denied or removed
  // Removed, then left the lobby themselves: still waits (no way round the removal).
  assert.equal(directEntryAllowed([{ removedByTeacher: false }, { removedByTeacher: true }]), false);
});

test('switching direct entry on admits everyone waiting except students the teacher removed', () => {
  const w = (id: string, studentId: string | null, displayName: string) => ({
    id, role: 'STUDENT', status: 'WAITING', studentId, classSessionId: 'cs1', displayName,
  });
  const waiting = [w('a', 's1', 'Asha'), w('b', 's2', 'Ravi'), w('c', null, 'Test kid'), w('d', null, 'Other kid')];
  const removed = [
    { studentId: 's2', classSessionId: 'cs1', displayName: 'Ravi' },
    { studentId: null, classSessionId: null, displayName: 'Test kid' },
  ];
  assert.deepEqual(idsToAdmitOnToggle(false, waiting, removed), ['a', 'd']);
  assert.deepEqual(idsToAdmitOnToggle(false, waiting), ['a', 'b', 'c', 'd']);
  assert.deepEqual(idsToAdmitOnToggle(true, waiting, []), []);
  // A removal in another class session does not block this one.
  assert.deepEqual(idsToAdmitOnToggle(false, [w('a', 's1', 'Asha')], [{ studentId: 's1', classSessionId: 'old', displayName: 'Asha' }]), ['a']);
  // Old callers (no owner fields) keep working.
  assert.deepEqual(idsToAdmitOnToggle(false, [{ id: 'x', role: 'STUDENT', status: 'WAITING' }]), ['x']);
  assert.notEqual(seatOwnerKey({ studentId: 's1', classSessionId: 'cs1', displayName: 'A' }), seatOwnerKey({ studentId: null, displayName: 'A' }));
});

test('only a teacher-issued leave marks the seat removed; the student Leave button does not', () => {
  const leave = src('app/api/rooms/[code]/leave/route.ts');
  assert.match(leave, /const removedByTeacher = !!participantId && target\.role === 'STUDENT'/);
  assert.match(leave, /removedByTeacher \? \{ removedByTeacher: true \} : \{\}/);
  // The participantId branch is teacher-only.
  assert.ok(leave.indexOf("if (!isRoomTeacher) return jsonError('Not in room', 403)") < leave.indexOf('const removedByTeacher'));
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  assert.match(schema, /removedByTeacher Boolean\s+@default\(false\)/);
});

test('arrival, the lobby poll and the manual join all use the same rule', () => {
  const svc = src('lib/studentService.ts');
  assert.match(svc, /directEntryAllowed\(earlier\) && shouldAutoAdmit\(room, participant\)/);
  assert.doesNotMatch(svc, /firstArrival/);
  const state = src('app/api/rooms/[code]/state/route.ts');
  assert.match(state, /admitIfDirectEntry\(room, access\.student\)/);
  const manual = src('app/api/rooms/[code]/join/route.ts');
  assert.match(manual, /directEntryAllowed\(previous\) && shouldAutoAdmit/);
  const admission = src('lib/admission.ts');
  assert.match(admission, /directEntryAllowed\(earlier\)/);
  assert.match(admission, /'EX', DIRECT_ENTRY_RETRY_S, 'NX'/); // lobby retries are throttled per seat
  assert.match(admission, /await clearRemovals\(room\.id, ids\)/); // a teacher admit lifts the removal
  const settings = src('app/api/rooms/[code]/settings/route.ts');
  assert.match(settings, /idsToAdmitOnToggle\(false, waiting, removed\)/);
});
