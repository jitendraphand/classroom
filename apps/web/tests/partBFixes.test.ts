import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classEndedNoted,
  clearClassEndedNotes,
  isClassEndedPacket,
  noteClassEnded,
  onceCached,
  preferFinish,
  verdictFromProbe,
} from '../src/lib/classEnded';
import { fullscreenGate, fullscreenGateText } from '../src/lib/focusStatus';
import { nameInitials } from '../src/lib/initials';
import { blankTileKind, TILE_CONNECT_MS } from '../src/lib/peerWindow';
import { connectedStudentCount, distinctConnectedStudents } from '../src/lib/connectedStudents';
import { tallyAttendance } from '../src/lib/attendance';
import { chatBottomReserve, chatPlaceholder, PHONE_CONTROL_RESERVE_PX } from '../src/hooks/useStudentLayout';
import { summarizeRoomParticipants } from '../src/lib/liveClassesLogic';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('class ended packet and disconnect verdict', () => {
  assert.equal(isClassEndedPacket({ v: 1, type: 'class-ended' }), true);
  assert.equal(isClassEndedPacket({ v: 1, type: 'state' }), false);
  assert.equal(isClassEndedPacket(null), false);

  assert.equal(
    verdictFromProbe({ httpStatus: 200, body: null, roomDeleted: true, participantRemoved: true, sawClassEnded: false, leaving: true }),
    'ignore'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 200, body: { status: 'LIVE' }, roomDeleted: false, participantRemoved: true, sawClassEnded: true, leaving: false }),
    'ended'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 410, body: null, roomDeleted: false, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'ended'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 200, body: { status: 'ENDED' }, roomDeleted: true, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'ended'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 200, body: { replaced: true }, roomDeleted: false, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'replaced'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 200, body: { public: true, meLeft: true }, roomDeleted: false, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'removed'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 0, body: null, roomDeleted: true, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'ended'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 503, body: null, roomDeleted: true, participantRemoved: false, sawClassEnded: false, leaving: false }),
    'ended'
  );
  // Still live, or the probe failed without the room being deleted: not a kick.
  assert.equal(
    verdictFromProbe({ httpStatus: 200, body: { status: 'LIVE', public: true }, roomDeleted: true, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'rejoin'
  );
  assert.equal(
    verdictFromProbe({ httpStatus: 0, body: null, roomDeleted: false, participantRemoved: true, sawClassEnded: false, leaving: false }),
    'rejoin'
  );

  assert.equal(preferFinish(null, 'removed'), 'removed');
  assert.equal(preferFinish('removed', 'ended'), 'ended');
  assert.equal(preferFinish('left', 'ended'), 'left');
  assert.equal(preferFinish('replaced', 'ended'), 'replaced');

  clearClassEndedNotes();
  assert.equal(classEndedNoted('ab12'), false);
  noteClassEnded('ab12', 1_000);
  assert.equal(classEndedNoted('AB12', 1_000 + 1_000), true);
  assert.equal(classEndedNoted('AB12', 1_000 + 120_001), false);
  clearClassEndedNotes();
});

test('session probe runs once and is reused until it expires', async () => {
  const cache = new Map();
  const inflight = new Map();
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 15));
    return { httpStatus: 200, body: { status: 'ENDED' } };
  };
  const opts = { key: 'end:ROOM', ttlMs: 1_000, cache, inflight, load, stamp: () => 5_000 };
  const [a, b] = await Promise.all([
    onceCached({ ...opts, now: 5_000 }),
    onceCached({ ...opts, now: 5_000 }),
  ]);
  assert.equal(a.httpStatus, 200);
  assert.equal(b.body?.status, 'ENDED');
  assert.equal(calls, 1);
  const again = await onceCached({ ...opts, now: 5_500 });
  assert.equal(again.httpStatus, 200);
  assert.equal(calls, 1);
  await onceCached({ ...opts, now: 6_001, stamp: () => 6_001 });
  assert.equal(calls, 2);
});

test('fullscreen gate does not block someone who was never fullscreen, or an iPhone', () => {
  assert.equal(fullscreenGate({ status: 'left', everFullscreen: false, iphone: false }), 'hint');
  assert.equal(fullscreenGate({ status: 'left', everFullscreen: true, iphone: false }), 'block');
  assert.equal(fullscreenGate({ status: 'away', everFullscreen: true, iphone: false }), 'block');
  assert.equal(fullscreenGate({ status: 'away', everFullscreen: false, iphone: true }), 'off');
  assert.equal(fullscreenGate({ status: 'left', everFullscreen: true, iphone: true }), 'off');
  assert.equal(fullscreenGate({ status: 'fullscreen', everFullscreen: true, iphone: false }), 'off');
  assert.equal(fullscreenGate({ status: 'unsupported', everFullscreen: false, iphone: false }), 'off');

  const first = fullscreenGateText({ status: 'left', everFullscreen: false });
  assert.equal(first.label, 'Tap for fullscreen');
  assert.equal(/return/i.test(first.label + first.title + first.body), false);
  const back = fullscreenGateText({ status: 'left', everFullscreen: true });
  assert.equal(back.label, 'Tap to return to fullscreen');
  const away = fullscreenGateText({ status: 'away', everFullscreen: true });
  assert.equal(away.label, 'Tap to come back');
  assert.equal(/return/i.test(away.label + away.title), false);
});

test('initials strip (you) and non-letters', () => {
  assert.equal(nameInitials('LT Teacher (you)'), 'LT');
  assert.equal(nameInitials('Ms. Rao (you)'), 'MR');
  assert.equal(nameInitials('(you)'), '?');
  assert.equal(nameInitials('李 明'), '李明');
  assert.equal(nameInitials('Asha'), 'AS');
  assert.equal(nameInitials(''), '?');
});

test('blank tiles connect briefly and never say off camera with nobody there', () => {
  assert.equal(TILE_CONNECT_MS, 4_000);
  assert.equal(blankTileKind({ studentsInRoom: 0, pendingSample: 3, blankIndex: 0, settling: true }), 'empty');
  assert.equal(blankTileKind({ studentsInRoom: 80, pendingSample: 2, blankIndex: 0, settling: true }), 'connecting');
  assert.equal(blankTileKind({ studentsInRoom: 80, pendingSample: 2, blankIndex: 2, settling: true }), 'off-camera');
  assert.equal(blankTileKind({ studentsInRoom: 80, pendingSample: 2, blankIndex: 0, settling: false }), 'off-camera');
  // Every student already has a tile: the spare tiles are empty, not "Off camera".
  assert.equal(blankTileKind({ studentsInRoom: 3, pendingSample: 0, blankIndex: 0, settling: false, shownStudents: 3 }), 'empty');
  assert.equal(blankTileKind({ studentsInRoom: 5, pendingSample: 0, blankIndex: 1, settling: false, shownStudents: 3 }), 'off-camera');
  assert.equal(blankTileKind({ studentsInRoom: 5, pendingSample: 0, blankIndex: 2, settling: false, shownStudents: 3 }), 'empty');
  assert.equal(blankTileKind({ studentsInRoom: 4, pendingSample: 0, blankIndex: 0, settling: true }), 'off-camera');
});

test('one distinct student across devices, observers excluded', () => {
  const list = [
    { identity: 'teacher_t', metadata: '{"role":"TEACHER"}' },
    { identity: 'student_a', metadata: '{"role":"STUDENT","studentId":"s1"}', studentId: 's1' },
    { identity: 'student_b', metadata: '{"role":"STUDENT","studentId":"s1"}', studentId: 's1' },
    { identity: 'student_c', metadata: '{"role":"STUDENT","studentId":"s2"}' },
    { identity: 'adminobserver_x', metadata: '{"role":"OBSERVER"}' },
    { identity: 'adminpreview_y', metadata: '{"role":"ADMIN"}' },
  ];
  assert.equal(connectedStudentCount(list), 2);
  assert.deepEqual(
    distinctConnectedStudents(list).map((p) => p.identity),
    ['student_a', 'student_c']
  );
  const summary = summarizeRoomParticipants(list);
  assert.equal(summary.studentCount, 2);
  assert.equal(summary.teacherConnected, true);
  assert.deepEqual(summary.studentIdentities, ['student_a', 'student_c']);
});

test('attendance totals count each student once', () => {
  const t = tallyAttendance([
    { studentId: 's1', status: 'present' },
    { studentId: 's1', status: 'present' },
    { studentId: 's2', status: 'late' },
    { studentId: '', status: 'present' },
    { studentId: 's3', status: 'not_admitted' },
    { studentId: 's3', status: 'late' },
  ]);
  assert.deepEqual(t, { present: 1, late: 1, notAdmitted: 1 });
});

test('phone chat placeholder and bottom reserve', () => {
  assert.equal(chatPlaceholder(false, true), 'To teacher…');
  assert.equal(chatPlaceholder(false, true).includes('Message your'), false);
  assert.equal(chatPlaceholder(false, false), 'Write a message…');
  assert.equal(chatPlaceholder(true, true, 'Ada'), 'Private message to Ada…');
  assert.equal(chatBottomReserve(390, 844), PHONE_CONTROL_RESERVE_PX);
  assert.ok(PHONE_CONTROL_RESERVE_PX >= 44);
  assert.equal(chatBottomReserve(844, 390), 8);
  assert.equal(chatBottomReserve(1280, 800), 8);
});

test('part B is wired: signal before delete, in-page end, hands, 44px targets', () => {
  const end = src('lib/teacherRoom.ts');
  const signalAt = end.indexOf("type: 'class-ended'");
  const deleteAt = end.indexOf('deleteRoom(');
  assert.ok(signalAt > 0 && deleteAt > signalAt, 'class-ended packet goes out before the room is deleted');

  const room = classroomViewSource();
  assert.match(room, /data-testid="end-class-confirm"/);
  assert.match(room, /End class for everyone\?/);
  assert.doesNotMatch(room, /confirm\('End class for everyone\?'\)/);
  assert.match(room, /data-testid="raised-hands-toast"/);
  assert.match(room, /verdictFromProbe/);
  assert.match(room, /qualityLost\.add\(p\.identity\)/);
  assert.doesNotMatch(room, /apply\(p\.identity, 'lost'/);
  assert.match(room, /data-testid="fullscreen-hint"/);

  const css = src('app/globals.css');
  assert.match(css, /--rail-btn: clamp\(44px/);
  assert.match(css, /\.raised-hands-toast/);
  assert.match(css, /\.control-status-pill\.is-second/);

  assert.match(src('app/api/rooms/[code]/token/route.ts'), /studentId: participant\.studentId/);
  assert.match(src('components/classroom/ClassroomGuard.tsx'), /Something went wrong in the classroom/);
  assert.match(src('components/classroom/ClassroomGuard.tsx'), /Checking the class…/);
  assert.match(src('app/classroom/[code]/page.tsx'), /ClassroomGuard/);
});
