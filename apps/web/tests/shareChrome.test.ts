import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BADGE_AMBER,
  BADGE_TEXT,
  FOCUS_BADGE_TEXT,
  FOCUS_RED,
  MEETING_BAR_ORDER,
  MEETING_BAR_PX,
  OMITTED_SHARE_CONTROLS,
  SHARE_TOOLBAR_ORDER,
  admitLabel,
  admitTone,
  badgeText,
  focusAlertDanger,
  inlineShareDockHint,
  meetingBarIds,
  peopleBadgeCount,
  sharePositionNoticeOpen,
  shareToolbarIds,
  shareToolbarSeparators,
} from '../src/lib/shareChrome';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('share toolbar order matches the Windows pill and omits controls with no web equivalent', () => {
  assert.deepEqual(shareToolbarIds({ video: true }), [...SHARE_TOOLBAR_ORDER]);
  assert.deepEqual(SHARE_TOOLBAR_ORDER, [
    'grip',
    'live',
    'mic',
    'cam',
    'videos',
    'video',
    'chat',
    'hands',
    'people',
    'admit',
    'stop',
  ]);
  assert.deepEqual(shareToolbarIds({}), SHARE_TOOLBAR_ORDER.filter((id) => id !== 'video'));
  assert.ok(!shareToolbarIds({ videos: false }).includes('videos'));
  // Teacher annotation on a screen share was removed (Nov 26).
  assert.ok(!(SHARE_TOOLBAR_ORDER as readonly string[]).includes('annotate'));
  assert.deepEqual(OMITTED_SHARE_CONTROLS, ['eco', 'sound']);
  const order = SHARE_TOOLBAR_ORDER as readonly string[];
  for (const id of OMITTED_SHARE_CONTROLS) assert.ok(!order.includes(id));
  assert.deepEqual(shareToolbarSeparators(shareToolbarIds({ video: true })), [{ before: 'chat' }, { before: 'stop' }]);
});

test('badges and admit follow the Windows rules', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(admitLabel(0), 'Nobody waiting');
  assert.equal(admitLabel(1, 'Ava'), 'Admit Ava');
  assert.equal(admitLabel(3), 'Admit all 3 waiting');
  assert.equal(admitTone(0), 'idle');
  assert.equal(admitTone(2), 'warn');
});

test('meeting bar order and focus badge', () => {
  assert.deepEqual(meetingBarIds(), [...MEETING_BAR_ORDER]);
  assert.deepEqual(MEETING_BAR_ORDER, ['mic', 'cam', 'chat', 'people', 'admit', 'perm', 'muteall', 'videos', 'stop', 'end']);
  assert.equal(MEETING_BAR_PX, 54);
  assert.equal(peopleBadgeCount(2, 1), 3);
  assert.equal(peopleBadgeCount(-1, 4), 4);
  assert.equal(focusAlertDanger(0), false);
  assert.equal(focusAlertDanger(1), true);
});

test('people count is amber with dark text; red is only the fullscreen badge', () => {
  assert.equal(BADGE_AMBER, '#f59e0b');
  assert.equal(BADGE_TEXT, '#1c1f26');
  assert.equal(FOCUS_RED, '#dc2626');
  assert.equal(FOCUS_BADGE_TEXT, '#ffffff');
  const hud = src('components/classroom/TeacherShareHud.tsx');
  assert.match(hud, /data-testid="tsh-people-count"/);
  assert.match(hud, /background: BADGE_AMBER, color: BADGE_TEXT/);
  assert.match(hud, /data-testid="tsh-focus-alert"/);
  assert.match(hud, /background: FOCUS_RED, color: FOCUS_BADGE_TEXT, left: -4, right: 'auto'/);
});

test('Wayland position note is a tooltip and a one-time toast, not the yellow strip', () => {
  const hints = { share: 'share', screens: 'screens', unsafe: 'unsafe' };
  assert.equal(inlineShareDockHint('position', hints), undefined);
  assert.equal(inlineShareDockHint('screens', hints), 'screens');
  assert.equal(inlineShareDockHint('unsafe', hints), 'unsafe');
  assert.equal(inlineShareDockHint('unsupported', hints), 'share');
  assert.equal(inlineShareDockHint('', hints), 'share');
  assert.equal(sharePositionNoticeOpen(null), true);
  assert.equal(sharePositionNoticeOpen('1'), false);
  const room = classroomViewSource();
  assert.match(room, /inlineShareDockHint\(/);
  assert.match(room, /SHARE_POSITION_NOTICE_KEY/);
  assert.match(room, /data-testid="share-position-toast"/);
  assert.match(room, /toolbarTitle=\{maskFallback === 'position' \? MONITOR_POSITION_HINT/);
  assert.doesNotMatch(room, /share-inline-hint/);
});

test('share pill, meeting bar, and video header are wired without dropping the older guards', () => {
  const hud = src('components/classroom/TeacherShareHud.tsx');
  assert.match(hud, /shareToolbarIds\(/);
  assert.match(hud, /aria-label=\{props\.stopLabel \?\? 'Stop sharing screen'\}/);
  assert.match(hud, /data-testid="share-inline-dock"/);
  assert.match(hud, /share_controls_v2/);
  // No annotation on a screen share (Nov 26).
  assert.doesNotMatch(hud, /AnnotateTools|useTeacherInk|case 'annotate'/);
  assert.doesNotMatch(hud, /Share controls \(compact\)/);
  assert.doesNotMatch(hud, /aria-label="Low power/);
  assert.doesNotMatch(hud, /Send computer sound/);
  const room = classroomViewSource();
  assert.match(room, /minLeft=\{wbOpen \? WB_TOOL_CLEAR_PX : 0\}/);
  // Class home fills the stage; share and whiteboard float (no docking).
  assert.match(room, /dock=\{videoOverlay \? null : dockArea\}/);
  assert.match(room, /data-testid="video-panel-resize"/);
  assert.match(src('components/classroom/Controls.tsx'), /aria-label="Video panel"/);
  assert.doesNotMatch(room, /TeacherInk|ShareDrawing|DrawOverlay/);
  // One button cycles 2 → 4 → 6 tiles, one closes the window; no minimize.
  assert.match(room, /data-testid="videos-slots"/);
  assert.match(room, /data-testid="videos-close"/);
  assert.doesNotMatch(room, /videos-min|videos-layout-/);
  assert.match(room, /!wbOpen && \(/);
  const host = src('components/classroom/Whiteboard.tsx');
  assert.match(host, /right: MEETING_BAR_PX/);
  assert.doesNotMatch(host, /wb-video-slot/);
});
