import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionEvents, decideHandoff, endedSessionCopy, focusLabel } from '../src/shared/session';
import { LABEL_UNAVAILABLE, LABEL_WGC, SCREEN_SHARE, TEACHER_CAMERA, WDA_EXCLUDEFROMCAPTURE, capturePlan, cssScreenWidth, dockGridStyle, dockTilePx, isOfferedShareWindow, matchPhysicalDisplay, planMask, screenShareSimulcastFor, shareAllowed, sideWindowBox, videoPanelSize, windowShouldBeCaptureExcluded } from '../src/shared/capture';
import {
  isSafeApiPath,
  mergeMessages,
  normalizeServer,
  parseRoomState,
  parseSchedule,
  passwordProblem,
  regionFrameRect,
  teacherCookieFromSetCookie,
  unreadCount,
} from '../src/shared/apiModel';
import { applyAnnotateOp, quantize, strokeHit, type AnnotateStroke } from '../src/shared/annotate';

test('use this device: a replaced session must sign in again; a live session reconnects', () => {
  assert.equal(decideHandoff({ kind: 'session', role: 'teacher', reason: 'signed_in_elsewhere' }), 'login');
  assert.equal(decideHandoff({ kind: 'device', role: null, reason: 'signed_in_elsewhere' }), 'login');
  assert.equal(decideHandoff({ kind: 'device', role: 'teacher', reason: null }), 'reconnect');
  assert.equal(endedSessionCopy('signed_in_elsewhere').title, 'You were signed in on another device');
});

test('a captured monitor rectangle maps onto that display in physical pixels', () => {
  const displays = [
    { id: 1, x: 0, y: 0, w: 1920, h: 1080 },
    { id: 2, x: 1920, y: 0, w: 1920, h: 1080 },
    { id: 3, x: -1920, y: 0, w: 1920, h: 1080 },
  ];
  assert.equal(matchPhysicalDisplay(displays, { x: 0, y: 0, w: 1920, h: 1080 }), '1');
  assert.equal(matchPhysicalDisplay(displays, { x: 1924, y: -3, w: 1912, h: 1086 }), '2');
  assert.equal(matchPhysicalDisplay(displays, { x: -1920, y: 0, w: 1920, h: 1080 }), '3');
  assert.equal(matchPhysicalDisplay(displays, { x: 4000, y: 0, w: 800, h: 600 }), '');
  assert.equal(matchPhysicalDisplay(displays, { x: 0, y: 0, w: 0, h: 1080 }), '');
});

test('capture plan: exclude only on Windows 10 2004+ with Graphics Capture', () => {
  const modern = capturePlan({ build: 19045, wgc: true });
  assert.equal(modern.mode, 'wgc-exclude');
  assert.equal(modern.affinity, WDA_EXCLUDEFROMCAPTURE);
  assert.equal(modern.mask, false);
  assert.equal(modern.label, LABEL_WGC);
  assert.equal(LABEL_WGC, 'Windows.Graphics.Capture, classroom windows excluded');
  const blocked = capturePlan({ build: 19045, wgc: false });
  assert.equal(blocked.mode, 'unavailable');
  assert.equal(blocked.affinity, WDA_EXCLUDEFROMCAPTURE);
  assert.equal(blocked.mask, false);
  assert.equal(blocked.label, LABEL_UNAVAILABLE);
  assert.equal(capturePlan({ build: 18362, wgc: true }).mode, 'unavailable');
  assert.equal(capturePlan(null).mask, false);
  assert.equal(capturePlan(null).affinity, WDA_EXCLUDEFROMCAPTURE);
});

test('each video tile is about a sixth of the work-area width', () => {
  const two = videoPanelSize({ width: 1920, height: 1080 }, 2);
  assert.equal(two.tileW, 320);
  assert.equal(two.tileH, 180);
  assert.equal(two.w, 648);
  assert.equal(two.h, 198);
  const six = videoPanelSize({ width: 1920, height: 1080 }, 6);
  assert.equal(six.tileW, 320);
  assert.equal(six.tileH, 180);
  assert.equal(six.w, 972);
  assert.equal(six.h, 382);
  const four = videoPanelSize({ width: 1920, height: 1080 }, 4);
  assert.equal(four.w, 648);
  assert.equal(four.h, 382);
  assert.ok(two.tileW > 96);
});

test('floating tiles stay a sixth of the work area and the meeting film fills its column', () => {
  assert.deepEqual(dockTilePx(1920), { w: 320, h: 180 });
  assert.deepEqual(dockTilePx(1280), { w: 213, h: 120 });
  assert.deepEqual(dockTilePx(0), { w: 320, h: 180 });
  assert.deepEqual(dockTilePx(2560), { w: 360, h: 203 });
  assert.equal(dockGridStyle(2).gridTemplateColumns, 'repeat(1, minmax(0, 1fr))');
  assert.equal(dockGridStyle(2).gridTemplateRows, 'repeat(2, minmax(0, 1fr))');
  assert.equal(dockGridStyle(4).gridTemplateColumns, 'repeat(1, minmax(0, 1fr))');
  assert.equal(dockGridStyle(4).gridTemplateRows, 'repeat(4, minmax(0, 1fr))');
  assert.equal(dockGridStyle(6).gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  assert.equal(dockGridStyle(6).gridTemplateRows, 'repeat(3, minmax(0, 1fr))');
  assert.equal(cssScreenWidth(undefined, 1280), 1280);
  assert.equal(cssScreenWidth(1920, 800), 1920);
});

test('published capture stays a single 720p stream', () => {
  assert.equal(SCREEN_SHARE.capture.width, 1280);
  assert.equal(SCREEN_SHARE.capture.height, 720);
  assert.ok(SCREEN_SHARE.capture.frameRate <= 10);
  assert.equal(SCREEN_SHARE.layers.length, 0);
  assert.equal(screenShareSimulcastFor(1280, 720), false);
  assert.equal(screenShareSimulcastFor(1920, 1080), false);
  assert.ok(TEACHER_CAMERA.capture.width <= 640);
  assert.ok(TEACHER_CAMERA.capture.frameRate <= 15);
});

test('every opaque classroom window is capture-excluded', () => {
  for (const name of ['toolbar', 'main', 'classroom-videos', 'roster', 'chat', 'devices', 'capture-test', 'annotate-preview']) {
    assert.equal(windowShouldBeCaptureExcluded(name), true, name);
  }
  assert.equal(windowShouldBeCaptureExcluded('annotate-overlay'), false);
  assert.equal(windowShouldBeCaptureExcluded('region-picker'), false);
  assert.equal(windowShouldBeCaptureExcluded(''), false);
  assert.equal(windowShouldBeCaptureExcluded('future-popup'), true);
});

test('the share picker does not offer classroom windows', () => {
  assert.equal(isOfferedShareWindow('Capture test'), false);
  assert.equal(isOfferedShareWindow('Classroom Teacher'), false);
  assert.equal(isOfferedShareWindow('Share controls'), false);
  assert.equal(isOfferedShareWindow('capture-test-notepad - Notepad'), true);
});

test('share is refused unless Graphics Capture can exclude the panels', () => {
  const blocked = capturePlan(null);
  assert.equal(shareAllowed(blocked, 'window').ok, false);
  assert.equal(shareAllowed(blocked, 'screen').ok, false);
  assert.equal(shareAllowed(blocked, 'region').ok, false);
  const modern = capturePlan({ build: 19045, wgc: true });
  assert.equal(shareAllowed(modern, 'window').ok, true);
  assert.equal(shareAllowed(modern, 'screen').ok, true);
});

test('mask maps a window onto the captured frame and fails closed when geometry is unknown', () => {
  const screen = { left: 0, top: 0, width: 1920, height: 1080 };
  const frame = { width: 1920, height: 1080 };
  const plan = planMask([{ x: 100, y: 80, w: 200, h: 40 }], [screen], frame, { trustZeroOrigin: true });
  assert.equal(plan.kind, 'rects');
  if (plan.kind === 'rects') {
    assert.equal(plan.rects.length, 1);
    assert.ok(plan.rects[0]!.w > 200);
  }
  const unsafe = planMask([{ x: 0, y: 0, w: 10, h: 10 }], [screen], frame, { trustZeroOrigin: false });
  assert.equal(unsafe.kind, 'unsafe');
  const trusted = planMask([{ x: 0, y: 0, w: 10, h: 10 }], [screen], frame, { trustZeroOrigin: true });
  assert.equal(trusted.kind, 'rects');
});

test('side windows sit above the toolbar and do not move it', () => {
  const toolbar = { x: 400, y: 700, w: 480, h: 48 };
  const avail = { left: 0, top: 0, width: 1920, height: 1080 };
  const chat = sideWindowBox('chat', toolbar, avail);
  const roster = sideWindowBox('roster', toolbar, avail);
  assert.ok(chat.top + chat.h <= toolbar.y);
  assert.ok(roster.left < chat.left);
  assert.equal(toolbar.x, 400);
  assert.equal(toolbar.y, 700);
});

test('cookie, server and password rules', () => {
  assert.deepEqual(teacherCookieFromSetCookie(['__Host-classroom_teacher=abc; Path=/; Secure']), {
    present: true,
    value: '__Host-classroom_teacher=abc',
  });
  assert.deepEqual(teacherCookieFromSetCookie(['classroom_teacher=; Max-Age=0']), { present: true, value: null });
  assert.equal(teacherCookieFromSetCookie(['other=1']).present, false);
  assert.equal(normalizeServer('https://13-201-89-150.sslip.io/'), 'https://13-201-89-150.sslip.io');
  assert.equal(normalizeServer('ftp://example.com'), null);
  assert.equal(isSafeApiPath('/api/rooms/ABC/state'), true);
  assert.equal(isSafeApiPath('https://evil/api'), false);
  assert.equal(isSafeApiPath('/api/../secret'), false);
  assert.equal(passwordProblem('short'), 'Use at least 10 characters.');
  assert.equal(passwordProblem('correct-horse', { current: 'correct-horse' })?.includes('different'), true);
});

test('schedule and room snapshots parse the teacher payloads', () => {
  const sched = parseSchedule({
    today: '2026-10-03',
    timezone: 'Asia/Kolkata',
    classes: [
      {
        key: 'slot:1:2026-10-03',
        date: '2026-10-03',
        subject: 'Math',
        audience: '7-A',
        startLabel: '09:00',
        endLabel: '09:40',
        canStart: true,
        mine: true,
        phase: 'open',
        session: { live: true },
      },
    ],
    gradeChoices: [{ grade: '7', label: 'Grade 7', whole: true, divisions: [{ name: 'A', label: 'A' }] }],
    active: { code: 'ABCD', subject: 'Math', audience: '7-A' },
  });
  assert.equal(sched.classes[0]?.live, true);
  assert.equal(sched.classes[0]?.timeLabel, '09:00–09:40');
  assert.equal(sched.activeCode, 'ABCD');
  assert.equal(sched.grades[0]?.whole, true);

  const room = parseRoomState({
    code: 'ABCD',
    name: 'Math',
    status: 'LIVE',
    isTeacher: true,
    waitingRoomOn: true,
    maxVisibleVideos: 3,
    stageMode: 'idle',
    me: { id: 't1' },
    visibleIdentities: ['student_a'],
    waiting: [{ id: 'w1', displayName: 'Asha', createdAt: '2026-10-03T10:00:00.000Z' }],
    admitted: [
      {
        id: 's1',
        displayName: 'Ben',
        role: 'STUDENT',
        livekitIdentity: 'student_a',
        mutedByTeacher: true,
        handRaised: true,
        handRaisedAt: 50,
        pinned: true,
        pinnedAt: 10,
        focus: 'left',
      },
    ],
    classSession: { subject: 'Math', audience: '7-A' },
  });
  assert.equal(room?.admitted[0]?.handRaisedAt, 50);
  assert.equal(room?.admitted[0]?.focus, 'left');
  assert.equal(room?.classLabel, 'Math · 7-A');
  assert.equal(room?.waiting.length, 1);
});

test('chat merge keeps the newest copy and unread ignores the teacher', () => {
  const a = {
    id: '1',
    senderParticipantId: 's',
    senderName: 'Asha',
    senderRole: 'STUDENT',
    body: 'hi',
    scope: 'TEACHER',
    recipientParticipantId: null,
    recipientName: null,
    createdAt: '2026-10-03T10:00:00.000Z',
  };
  const b = { ...a, id: '2', senderParticipantId: 't', senderRole: 'TEACHER', body: 'hello', createdAt: '2026-10-03T10:00:01.000Z' };
  const merged = mergeMessages([a], [a, b]);
  assert.deepEqual(merged.map((m) => m.id), ['1', '2']);
  assert.equal(unreadCount(merged, null, 't'), 1);
  assert.equal(unreadCount(merged, a.createdAt, 't'), 0);
});

test('attention events fire once per new waiter, hand, message and focus alert', () => {
  const events = attentionEvents({
    prevWaiting: [],
    nextWaiting: [{ id: 'w', displayName: 'Asha' }],
    prevStudents: [{ id: 's', displayName: 'Ben', handRaised: false, focus: 'fullscreen' }],
    nextStudents: [{ id: 's', displayName: 'Ben', handRaised: true, focus: 'left' }],
    prevMessages: [],
    nextMessages: [
      { id: 'm', senderParticipantId: 's', senderName: 'Ben', body: 'question' },
      { id: 'mine', senderParticipantId: 't', senderName: 'Me', body: 'ok' },
    ],
    myParticipantId: 't',
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ['waiting', 'hand', 'focus', 'message']
  );
  const again = attentionEvents({
    prevWaiting: [{ id: 'w', displayName: 'Asha' }],
    nextWaiting: [{ id: 'w', displayName: 'Asha' }],
    prevStudents: [{ id: 's', displayName: 'Ben', handRaised: true, focus: 'left' }],
    nextStudents: [{ id: 's', displayName: 'Ben', handRaised: true, focus: 'left' }],
    prevMessages: [{ id: 'm', senderParticipantId: 's', senderName: 'Ben', body: 'question' }],
    nextMessages: [{ id: 'm', senderParticipantId: 's', senderName: 'Ben', body: 'question' }],
    myParticipantId: 't',
  });
  assert.deepEqual(again, []);
  assert.equal(focusLabel('left'), 'Left fullscreen');
});

test('region crop stays inside the frame', () => {
  const r = regionFrameRect(
    { x: 100, y: 50, w: 800, h: 600 },
    { x: 0, y: 0, w: 1600, h: 900 },
    { width: 1920, height: 1080 }
  );
  assert.ok(r);
  assert.ok(r!.sx >= 0 && r!.sy >= 0);
  assert.ok(r!.sx + r!.sw <= 1920);
  assert.equal(regionFrameRect({ x: 0, y: 0, w: 8, h: 8 }, { x: 0, y: 0, w: 100, h: 100 }, { width: 100, height: 100 }), null);
});

test('annotation quantize, eraser and ops', () => {
  assert.deepEqual(quantize([0.123456, 1.2]), [0.1235, 1]);
  const stroke: AnnotateStroke = {
    id: 's1',
    tool: 'pen',
    color: '#ef4444',
    width: 3,
    points: [
      [0.1, 0.1],
      [0.9, 0.1],
    ],
  };
  assert.equal(strokeHit(stroke, [0.5, 0.1]), true);
  assert.equal(strokeHit(stroke, [0.5, 0.9]), false);
  const begun = applyAnnotateOp([], { v: 1, type: 'begin', stroke, from: 't' });
  const grown = applyAnnotateOp(begun, { v: 1, type: 'point', id: 's1', p: [0.95, 0.1], from: 't' });
  assert.equal(grown[0]?.points.length, 3);
  assert.deepEqual(applyAnnotateOp(grown, { v: 1, type: 'undo', id: 's1', from: 't' }), []);
});
