import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { academicYearForDate, academicYearProblem, formatAcademicYear, isAcademicYearLabel } from '../src/lib/academicYear';
import { CLASS_FULL_MESSAGE, classCapacity, classTone, seatsLeft, todayTag } from '../src/lib/capacity';
import { averageStars, feedbackProblem, normalizeFeedbackComment, presentStars } from '../src/lib/feedbackText';
import { normalizeMicLimit, studentSetMic, teacherSetMic } from '../src/lib/micSlots';
import { hasPrivilege, parsePrivilegeBody, privilegeSetFrom, visibleAdminTabs } from '../src/lib/privileges';
import { RANK_MIN_RATINGS, bayesianAverage, rankTeachers, weekStartMonday } from '../src/lib/ranking';
import { nextStudentVideoMode, parseStudentVideoMode } from '../src/lib/studentVideoMode';
import { chatVisibleTo } from '../src/lib/chatBus';

test('academic year is June–May and editable labels must match', () => {
  assert.equal(academicYearForDate('2026-06-01'), '2026-27');
  assert.equal(academicYearForDate('2026-03-15'), '2025-26');
  assert.equal(formatAcademicYear(2026), '2026-27');
  assert.equal(isAcademicYearLabel('2026-27'), true);
  assert.equal(isAcademicYearLabel('2026-28'), false);
  assert.equal(academicYearProblem('2026-27'), null);
  assert.ok(academicYearProblem('26-27'));
});

test('feedback rejects bad stars and characters, and teachers only see stars', () => {
  assert.equal(feedbackProblem(5, ''), null);
  assert.equal(feedbackProblem(5, 'Good class!'), null);
  assert.equal(feedbackProblem(5, 'नमस्ते 7'), null);
  assert.ok(feedbackProblem(0, ''));
  assert.ok(feedbackProblem(5, 'a'.repeat(101)));
  assert.ok(feedbackProblem(5, 'no @ signs'));
  assert.equal(normalizeFeedbackComment('  hi  '), 'hi');
  assert.equal(normalizeFeedbackComment('   '), null);
  const secret = 'secret-comment-xyz';
  const stars = presentStars(
    [
      { studentId: 'a', stars: 5, comment: secret },
      { studentId: 'b', stars: 1, comment: secret },
    ],
    new Set(['a'])
  );
  assert.deepEqual(stars, [5]);
  assert.equal(JSON.stringify(stars).includes(secret), false);
  assert.equal(averageStars([5, 4]), 4.5);
  assert.equal(averageStars([]), null);
});

test('teacher home and teacher routes never select written feedback', () => {
  const home = readFileSync(new URL('../src/lib/teacherHome.ts', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/teacher/home/route.ts', import.meta.url), 'utf8');
  assert.equal(home.includes('comment'), false);
  assert.equal(route.includes('comment'), false);
});

test('ranking uses a Bayesian average and a minimum of 5 ratings', () => {
  assert.equal(bayesianAverage(5, 0), 4);
  const rows = rankTeachers([
    { id: 'low', ratings: [1, 1, 1, 1, 1] },
    { id: 'high', ratings: [5, 5, 5, 5, 5] },
    { id: 'new', ratings: [5, 5] },
  ]);
  const high = rows.find((r) => r.id === 'high')!;
  const low = rows.find((r) => r.id === 'low')!;
  const newbie = rows.find((r) => r.id === 'new')!;
  assert.ok(high.bayesianAvg > low.bayesianAvg);
  assert.equal(high.percentile, 100);
  assert.equal(low.percentile, 0);
  assert.equal(newbie.eligible, false);
  assert.equal(newbie.percentile, null);
  assert.equal(newbie.ratingCount < RANK_MIN_RATINGS, true);
  const solo = rankTeachers([{ id: 'only', ratings: [5, 5, 5, 5, 5] }]);
  assert.equal(solo[0]!.percentile, 100);
  assert.equal(weekStartMonday('2026-10-21', 3), '2026-10-19');
  assert.equal(weekStartMonday('2026-10-18', 0), '2026-10-12');
});

test('privileges: system has all, sub-admins only what was checked, tabs follow', () => {
  const system = privilegeSetFrom({ kind: 'SYSTEM', privManageTeachers: false });
  assert.equal(hasPrivilege(system, 'SYSTEM', 'manageTeachers'), true);
  const sub = privilegeSetFrom({ kind: 'SUB', privSchedule: true, privViewReports: false });
  assert.equal(hasPrivilege(sub, 'SUB', 'schedule'), true);
  assert.equal(hasPrivilege(sub, 'SUB', 'viewReports'), false);
  assert.deepEqual(visibleAdminTabs(sub, 'SUB'), ['today', 'system']);
  assert.equal(parsePrivilegeBody({ manageTeachers: true }), null);
  const parsed = parsePrivilegeBody({
    manageTeachers: true,
    schedule: false,
    monitorLive: true,
    viewReports: false,
    manageSchool: false,
  });
  assert.equal(parsed?.manageTeachers, true);
  assert.equal(parsed?.schedule, false);
});

test('mic cap queues students and only auto-promotes teacher-approved waiters', () => {
  assert.equal(normalizeMicLimit(0), 0);
  assert.equal(normalizeMicLimit(-3), 0);
  assert.equal(normalizeMicLimit(2.8), 2);
  let book = teacherSetMic({ open: [], queue: [] }, 'a', false, 1);
  assert.equal(book.granted, true);
  book = teacherSetMic(book, 'b', false, 1);
  assert.equal(book.waiting, true);
  assert.equal(book.queue[0]!.source, 'teacher');
  const muted = teacherSetMic(book, 'a', true, 1);
  assert.deepEqual(muted.open, ['b']);
  const ask = studentSetMic({ open: ['a'], queue: [] }, 'c', true, 1);
  assert.equal(ask.waiting, true);
  assert.equal(ask.queue[0]!.source, 'student');
  const freed = studentSetMic(ask, 'a', false, 1);
  assert.equal(freed.open.includes('c'), false);
  const unlimited = studentSetMic({ open: [], queue: [] }, 'c', true, 0);
  assert.equal(unlimited.granted, true);
  assert.deepEqual(unlimited.open, []);
  const underCap = studentSetMic({ open: [], queue: [] }, 'c', true, 3);
  assert.equal(underCap.granted, false);
  assert.equal(underCap.waiting, true);
  assert.deepEqual(underCap.open, []);
});

test('class full only when a positive limit is configured', () => {
  assert.equal(classCapacity(null), null);
  assert.equal(classCapacity(0), null);
  assert.equal(classCapacity(40), 40);
  assert.deepEqual(seatsLeft(null, 100, 5), { admit: 5, full: false });
  assert.deepEqual(seatsLeft(10, 10, 2), { admit: 0, full: true });
  assert.deepEqual(seatsLeft(10, 8, 5), { admit: 2, full: false });
  assert.equal(CLASS_FULL_MESSAGE, 'This class is full.');
  assert.equal(classTone({ date: '2026-10-20', today: '2026-10-20', nowMinute: 600, startMinute: 540, endMinute: 600, started: true, ended: false }), 'today');
  assert.equal(classTone({ date: '2026-10-19', today: '2026-10-20', nowMinute: 600, startMinute: 540, endMinute: 600, started: false, ended: false }), 'skipped');
  assert.equal(todayTag({ nowMinute: 500, startMinute: 540, started: false, ended: false, live: false }), 'starts');
  assert.equal(todayTag({ nowMinute: 600, startMinute: 540, started: false, ended: false, live: false }), 'not_taken');
  assert.equal(todayTag({ nowMinute: 600, startMinute: 540, started: true, ended: false, live: true }), 'ongoing');
  assert.equal(todayTag({ nowMinute: 700, startMinute: 540, started: true, ended: true, live: false }), 'completed');
});

test('student video panel cycles both → teacher → minimized', () => {
  assert.equal(nextStudentVideoMode('both'), 'teacher');
  assert.equal(nextStudentVideoMode('teacher'), 'min');
  assert.equal(nextStudentVideoMode('min'), 'both');
  assert.equal(parseStudentVideoMode('nope'), 'both');
});

test('chat SSE does not deliver a direct message to a classmate', () => {
  const push = {
    message: { id: '1', scope: 'DIRECT', senderParticipantId: 't', recipientParticipantId: 's1' },
    participantIds: ['t', 's1'],
  };
  assert.equal(chatVisibleTo(push, { isTeacher: true, participantId: 't' }), true);
  assert.equal(chatVisibleTo(push, { isTeacher: false, participantId: 's1' }), true);
  assert.equal(chatVisibleTo(push, { isTeacher: false, participantId: 's2' }), false);
});

test('screen share capture is above 8 fps and keeps a 720p layer', () => {
  const src = readFileSync(new URL('../src/lib/videoQuality.ts', import.meta.url), 'utf8');
  assert.match(src, /frameRate: \{ ideal: 24, max: 30 \}/);
  assert.match(src, /width: 1280, height: 720/);
});
