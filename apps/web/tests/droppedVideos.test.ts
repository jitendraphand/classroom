import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isRosterDropped, selectTeacherVideos, videoHidden } from '../src/lib/droppedVideos';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const now = 1_700_000_000_000;

test('a dropped map hides only once its moment has arrived', () => {
  const dropped = new Map<string, number>([
    ['student_a', now + 1_000],
    ['student_b', now],
  ]);
  assert.equal(isRosterDropped('student_a', dropped, now), false, 'future mark is still in grace');
  assert.equal(isRosterDropped('student_b', dropped, now - 1), false);
  assert.equal(isRosterDropped('student_b', dropped, now), true);
  assert.equal(isRosterDropped('student_c', dropped, now + 5_000), false);
  assert.equal(isRosterDropped('', dropped, now), false);
  assert.equal(isRosterDropped('student_b', null, now), false);
  assert.equal(isRosterDropped('student_b', undefined, now), false);
  assert.equal(isRosterDropped('student_b', new Map([['student_b', Number.NaN]]), now), false);
});

test('a dropped set is already gone, with no extra grace', () => {
  const gone = new Set(['student_a']);
  assert.equal(isRosterDropped('student_a', gone, now), true);
  assert.equal(isRosterDropped('student_b', gone, now), false);
  assert.equal(videoHidden('student_a', { dropped: gone, now }), true);
});

test('the live roster hides missing students and never hides a teacher for that reason', () => {
  const roster = new Set(['student_a']);
  assert.equal(videoHidden('student_b', { now, liveRoster: roster }), true);
  assert.equal(videoHidden('student_a', { now, liveRoster: roster }), false);
  assert.equal(videoHidden('teacher_1', { now, liveRoster: roster }), false);
  assert.equal(videoHidden('guest', { now, liveRoster: roster }), false);
  assert.equal(videoHidden('student_b', { now, liveRoster: null }), false, 'roster not loaded yet');
  assert.equal(videoHidden('student_b', { now }), false);
  assert.equal(videoHidden('', { now, liveRoster: roster }), false);
});

test('visible-video selection drops crashed students, collapses duplicates, and restores one tile', () => {
  const dropped = new Map<string, number>([['student_b', now - 10]]);
  const roster = new Set(['student_a', 'student_b', 'student_c']);
  assert.deepEqual(
    selectTeacherVideos(
      ['student_a', 'student_b', 'student_a', 'teacher_1', 'student_c', ''],
      { dropped, now, liveRoster: roster }
    ),
    ['student_a', 'teacher_1', 'student_c']
  );

  const back = new Map<string, number>();
  assert.deepEqual(
    selectTeacherVideos(['student_b', 'student_b', 'student_a'], {
      dropped: back,
      now,
      liveRoster: new Set(['student_a', 'student_b']),
    }),
    ['student_b', 'student_a'],
    'reconnect is the same identity once'
  );

  assert.deepEqual(
    selectTeacherVideos(['student_a', 'student_z'], {
      dropped: back,
      now,
      liveRoster: new Set(['student_a']),
    }),
    ['student_a'],
    'heartbeat removal hides even without a local lost mark'
  );
});

test('teacher video surfaces use the same drop as the roster', () => {
  const room = classroomViewSource();
  assert.match(room, /selectTeacherVideos\(/);
  assert.match(room, /visibleIdentities=\{shownVisibles\}/);
  assert.match(room, /hiddenIdentities=\{hiddenVideoList\}/);
  assert.match(room, /if \(pub\.isSubscribed\) pub\.setSubscribed\(false\)/);
  assert.match(room, /videoHidden\(s\.identity/);
  const spots = [...room.matchAll(/<SpotlightFloat\b[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.equal(spots.length, 2, 'student classmate view and the teacher spotlight');
  assert.equal(spots.filter((s) => s.includes('hidden={')).length, 1);
  assert.match(spots.find((s) => s.includes('hidden={')) ?? '', /videoHidden\(/);

  const spotlight = src('components/classroom/SpotlightFloat.tsx');
  assert.match(spotlight, /hidden\?: boolean/);
  assert.match(spotlight, /if \(hidden\) return null/);
  assert.match(spotlight, /pub\.setSubscribed\(false\)/);

  const state = src('app/api/rooms/[code]/state/route.ts');
  assert.match(state, /selectTeacherVideos\(visible,/);
  assert.match(state, /visibleIdentities: visibleForView/);
  assert.match(state, /visibleCount: visibleForView\.length/);
  assert.match(state, /visible\.includes\(me\.livekitIdentity\)/);
  assert.match(state, /isVisible: p\.role === 'TEACHER' \|\| visible\.includes\(p\.livekitIdentity\)/);
  assert.doesNotMatch(src('lib/sample.ts'), /droppedVideos/);
});
