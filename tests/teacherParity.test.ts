import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adhocBody, campusesOf, classStartLabel, classStatus, gradeOptionLabel, parseRoomState, parseSchedule, type ClassChoice } from '../src/shared/apiModel';
import { THICKNESS_MAX, THICKNESS_MIN, toolWidth } from '../src/shared/annotateOverlay';
import { SCREEN_SHARE, VIDEO_MODE_SHARE, inkRectFor, windowsShareEncodings } from '../src/shared/capture';
import { VIDEO_OFF_AFTER_MS, VIDEO_ON_AFTER_MS, nextVideoMode, type VideoModeState } from '../src/shared/videoMode';

const base: ClassChoice = {
  key: 'k',
  date: '2026-10-09',
  subject: 'Math',
  audience: '7-A',
  timeLabel: '09:00–09:40',
  canStart: true,
  live: false,
  mine: true,
  phase: 'open',
  note: null,
  startLabel: '09:00',
  endLabel: '09:40',
  opensAt: null,
  coveredBy: null,
  substituteFor: null,
  extra: false,
  sessionStarted: false,
  sessionEnded: false,
};

test('dashboard status badges and buttons use the web wording', () => {
  assert.equal(classStatus({ ...base, mine: false, coveredBy: 'Ms. B' }).text, 'Covered by Ms. B');
  assert.deepEqual(classStatus({ ...base, live: true }), { text: 'Live', tone: 'success', pulse: true });
  assert.equal(classStatus({ ...base, sessionEnded: true }).text, 'Ended · can reopen');
  assert.equal(classStatus(base).text, 'Open now');
  assert.equal(classStatus({ ...base, phase: 'upcoming', opensAt: 'X' }, (s) => `@${s}`).text, 'Opens @X');
  assert.equal(classStatus({ ...base, phase: 'past', sessionStarted: true }).text, 'Held');
  assert.equal(classStatus({ ...base, phase: 'past' }).text, 'Not held');
  assert.equal(classStartLabel(base), 'Start class');
  assert.equal(classStartLabel({ ...base, live: true }), 'Re-enter');
  assert.equal(classStartLabel({ ...base, sessionStarted: true }), 'Re-enter');
});

test('ad-hoc: campus first, then grades, divisions and the web request body', () => {
  const sched = parseSchedule({
    gradesConfigured: false,
    earlyMinutes: 10,
    gradeChoices: [
      { campus: 'CC', grade: '7', label: 'Grade 7', whole: true, divisions: [{ name: 'A', label: 'A' }] },
      { campus: 'NC', grade: '8', label: '8', whole: false, divisions: ['B'] },
      { campus: 'CC', grade: '9', label: 'Grade 9', whole: false, divisions: [] },
    ],
    classes: [{ key: 'x', startLabel: '09:00', endLabel: '09:40', coveredBy: 'T', mine: false, extra: true, opensAt: 'Z', session: { startedAt: 'a', endedAt: 'b' } }],
  });
  assert.equal(sched.gradesConfigured, false);
  assert.equal(sched.earlyMinutes, 10);
  assert.deepEqual(campusesOf(sched.grades), ['CC', 'NC']);
  assert.equal(gradeOptionLabel(sched.grades[0]!), 'Grade 7 (7)');
  assert.equal(gradeOptionLabel(sched.grades[1]!), '8');
  const c = sched.classes[0]!;
  assert.equal(c.coveredBy, 'T');
  assert.equal(c.extra, true);
  assert.equal(c.sessionStarted && c.sessionEnded, true);
  assert.equal(c.opensAt, 'Z');

  const common = { campus: 'CC', grade: '7', subject: ' Revision ', extra: 'C, D', freeTextExtra: true };
  assert.deepEqual(adhocBody({ ...common, divisions: [], all: false, freeTextExtra: false, extra: '' }), { error: 'Pick at least one division.' });
  assert.deepEqual(adhocBody({ ...common, divisions: ['A'], all: false }), {
    body: { kind: 'adhoc', campus: 'CC', grade: '7', divisions: ['A', 'C', 'D'], allDivisions: false, subject: 'Revision' },
  });
  // Extras are ignored once Grades & divisions is configured.
  const configured = adhocBody({ ...common, divisions: ['A'], all: false, freeTextExtra: false });
  assert.ok('body' in configured && configured.body.divisions.join() === 'A');
  const all = adhocBody({ ...common, divisions: [], all: true, extra: '', subject: '' });
  assert.ok('body' in all && all.body.allDivisions && !('subject' in all.body));
});

test('room snapshot carries the draw and desktop-ink fields', () => {
  const room = parseRoomState({
    code: 'ABCD',
    isTeacher: true,
    stageMode: 'screen',
    desktopInk: true,
    admitted: [{ id: 'p1', displayName: 'Asha', role: 'STUDENT', sid: 'S1', drawRequested: true, drawing: false }],
    waiting: [{ id: 'w1', displayName: 'Ravi', gradeDivision: 'CC · 7-A', late: true }],
  });
  assert.ok(room);
  assert.equal(room.desktopInk, true);
  assert.equal(room.admitted[0]?.sid, 'S1');
  assert.equal(room.admitted[0]?.drawRequested, true);
  assert.equal(room.waiting[0]?.gradeDivision, 'CC · 7-A');
  assert.equal(room.waiting[0]?.late, true);
});

test('video mode auto-detect turns on after a busy stretch and off after a quiet one', () => {
  let s: VideoModeState = { on: false, auto: true, highSince: null, lowSince: null };
  s = nextVideoMode(s, { now: 0, fps: 8, slidesCap: 8 });
  assert.equal(s.on, false);
  s = nextVideoMode(s, { now: VIDEO_ON_AFTER_MS - 1, fps: 7, slidesCap: 8 });
  assert.equal(s.on, false);
  s = nextVideoMode(s, { now: VIDEO_ON_AFTER_MS, fps: 8, slidesCap: 8 });
  assert.equal(s.on, true);
  // A dip resets the quiet timer.
  s = nextVideoMode(s, { now: 10_000, fps: 1, slidesCap: 8 });
  s = nextVideoMode(s, { now: 12_000, fps: 25, slidesCap: 8 });
  s = nextVideoMode(s, { now: 13_000, fps: 1, slidesCap: 8 });
  assert.equal(nextVideoMode(s, { now: 13_000 + VIDEO_OFF_AFTER_MS - 1, fps: 1, slidesCap: 8 }).on, true);
  assert.equal(nextVideoMode(s, { now: 13_000 + VIDEO_OFF_AFTER_MS, fps: 1, slidesCap: 8 }).on, false);
  // A busy frame in the middle of a slow start does not count.
  let t: VideoModeState = { on: false, auto: true, highSince: null, lowSince: null };
  t = nextVideoMode(t, { now: 0, fps: 8, slidesCap: 8 });
  t = nextVideoMode(t, { now: 2000, fps: 2, slidesCap: 8 });
  t = nextVideoMode(t, { now: 4500, fps: 8, slidesCap: 8 });
  assert.equal(t.on, false);
  // Manual: nothing changes by itself.
  const manual: VideoModeState = { on: true, auto: false, highSince: null, lowSince: null };
  assert.equal(nextVideoMode(manual, { now: 99_999, fps: 0, slidesCap: 8 }).on, true);
});

type Enc = { maxBitrate?: number; maxFramerate?: number };

test('share encodings: video mode is 30 fps, slides keep the 8 fps layer', () => {
  assert.equal(VIDEO_MODE_SHARE.encoding.maxFramerate, 30);
  const video = windowsShareEncodings<Enc>([{}, {}], true);
  assert.ok(video.every((e) => e.maxFramerate === 30 && e.maxBitrate === VIDEO_MODE_SHARE.encoding.maxBitrate));
  // Slides: this app's single 720p / 8 fps layer.
  const slides = windowsShareEncodings<Enc>([{}], false);
  assert.equal(slides[0]?.maxBitrate, SCREEN_SHARE.encoding.maxBitrate);
  assert.equal(slides[0]?.maxFramerate, SCREEN_SHARE.encoding.maxFramerate);
  assert.equal(windowsShareEncodings<Enc>([], false).length, 1);
});

test('student ink maps into a region share and 1:1 otherwise', () => {
  assert.deepEqual(inkRectFor('screen', null, null), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(inkRectFor('region', { x: 960, y: 0, w: 960, h: 540 }, { x: 0, y: 0, w: 1920, h: 1080 }), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  // Second monitor at negative x, clamped.
  const r = inkRectFor('region', { x: -1920, y: 100, w: 3000, h: 200 }, { x: -1920, y: 0, w: 1920, h: 1080 });
  assert.equal(r.x, 0);
  assert.equal(r.w, 1);
});

test('annotation thickness slider maps to each tool', () => {
  assert.equal(toolWidth('pen', 3), 3);
  assert.equal(toolWidth('pen', 99), THICKNESS_MAX);
  assert.equal(toolWidth('pen', -5), THICKNESS_MIN);
  assert.ok(toolWidth('highlight', 3) > toolWidth('pen', 3));
  assert.ok(toolWidth('text', 12) > toolWidth('text', 1));
});
