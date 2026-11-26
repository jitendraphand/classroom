/**
 * No waiting room (Nov 26): every student who may enter their class is
 * admitted on arrival. Rules in lib/admissionLogic.ts; wiring checked in the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { shouldAutoAdmit } from '../src/lib/admissionLogic';

const src = (p: string) => readFileSync(`src/${p}`, 'utf8');

test('every student seat not yet in is admitted while the class runs', () => {
  const seat = { role: 'STUDENT', status: 'WAITING' };
  assert.equal(shouldAutoAdmit({ status: 'LIVE' }, seat), true);
  assert.equal(shouldAutoAdmit({ status: 'WAITING' }, seat), true);
});

test('never into an ended class, never re-admits, never touches teachers', () => {
  assert.equal(shouldAutoAdmit({ status: 'ENDED' }, { role: 'STUDENT', status: 'WAITING' }), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE' }, { role: 'STUDENT', status: 'ADMITTED' }), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE' }, { role: 'STUDENT', status: 'LEFT' }), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE' }, { role: 'TEACHER', status: 'WAITING' }), false);
});

test('arrival, the joining-page poll and the manual join admit with the same rule', () => {
  const svc = src('lib/studentService.ts');
  assert.match(svc, /if \(shouldAutoAdmit\(room, participant\)\) \{/);
  assert.doesNotMatch(svc, /directEntryAllowed|waitingRoomOn/);
  assert.match(src('app/api/rooms/[code]/state/route.ts'), /admitIfDirectEntry\(room, access\.student\)/);
  const manual = src('app/api/rooms/[code]/join/route.ts');
  assert.match(manual, /if \(shouldAutoAdmit\(room, participant\)\) \{/);
  const admission = src('lib/admission.ts');
  assert.match(admission, /'EX', DIRECT_ENTRY_RETRY_S, 'NX'/);
  assert.doesNotMatch(admission, /directEntryAllowed|waitingRoomOn/);
});

test('the waiting room is gone: no toggle, no admit route, no waiting list', () => {
  assert.equal(existsSync('src/app/api/rooms/[code]/admit/route.ts'), false);
  assert.equal(existsSync('src/lib/waitingRoomPref.ts'), false);
  assert.doesNotMatch(src('app/api/rooms/[code]/settings/route.ts'), /waitingRoom/);
  const state = src('app/api/rooms/[code]/state/route.ts');
  assert.doesNotMatch(state, /waitingRoomOn|\n    waiting: /);
  for (const f of ['components/classroom/ClassroomRoom.tsx', 'components/classroom/TeacherShareHud.tsx', 'components/classroom/MeetingBar.tsx']) {
    const s = src(f);
    assert.doesNotMatch(s, /admitStudents|onAdmit|WaitingAdmitBar|setWaitingRoom|waitingRoomOn|IconUserPlus/, f);
  }
  assert.doesNotMatch(src('lib/teacherRoom.ts'), /waitingRoomDefaultFor/);
  assert.match(src('lib/teacherRoom.ts'), /waitingRoomOn: false/);
  assert.doesNotMatch(src('app/join/[code]/page.tsx'), /Enter waiting room|Waiting room'/);
});

test('classes have no size limit: no cap in admission, settings, lobby or API', () => {
  assert.doesNotMatch(src('lib/admission.ts'), /ClassFullError|classCapacity|seatsLeft|maxStudentsPerClass|advisory_xact_lock/);
  assert.doesNotMatch(src('lib/capacity.ts'), /export function (classCapacity|seatsLeft)|CLASS_FULL_MESSAGE/);
  assert.doesNotMatch(src('lib/schoolSettings.ts'), /maxStudentsPerClass: /);
  assert.doesNotMatch(src('app/api/admin/settings/route.ts'), /patch\.maxStudentsPerClass/);
  assert.doesNotMatch(src('app/admin/system/settings/page.tsx'), /Students per class|maxStudentsPerClass/);
  assert.doesNotMatch(src('app/api/rooms/[code]/state/route.ts'), /classFull/);
  for (const f of ['app/api/rooms/[code]/settings/route.ts', 'app/api/rooms/[code]/join/route.ts', 'lib/studentService.ts']) {
    assert.doesNotMatch(src(f), /ClassFullError|CLASS_FULL_MESSAGE/, f);
  }
});

test('only a teacher-issued leave marks the seat removed; the student comes back by joining again', () => {
  const leave = src('app/api/rooms/[code]/leave/route.ts');
  assert.match(leave, /const removedByTeacher = !!participantId && target\.role === 'STUDENT'/);
  assert.ok(leave.indexOf("if (!isRoomTeacher) return jsonError('Not in room', 403)") < leave.indexOf('const removedByTeacher'));
});
