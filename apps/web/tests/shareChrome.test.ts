import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANNOTATE_COLORS,
  ANNOTATE_GROUP_ORDER,
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
  annotateToolsPosInside,
  badgeText,
  clampPanel,
  flipOrient,
  focusAlertDanger,
  inlineShareDockHint,
  meetingBarIds,
  parseAnnotateToolsPos,
  peopleBadgeCount,
  placeAnnotateTools,
  sharePositionNoticeOpen,
  shareToolbarIds,
  shareToolbarSeparators,
  toolWidth,
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
    'annotate',
    'stop',
  ]);
  assert.deepEqual(shareToolbarIds({}), SHARE_TOOLBAR_ORDER.filter((id) => id !== 'video'));
  assert.ok(!shareToolbarIds({ videos: false }).includes('videos'));
  assert.ok(!shareToolbarIds({ annotate: false }).includes('annotate'));
  assert.deepEqual(OMITTED_SHARE_CONTROLS, ['eco', 'sound']);
  const order = SHARE_TOOLBAR_ORDER as readonly string[];
  for (const id of OMITTED_SHARE_CONTROLS) assert.ok(!order.includes(id));
  assert.deepEqual(shareToolbarSeparators(shareToolbarIds({ video: true })), [{ before: 'chat' }, { before: 'stop' }]);
});

test('badges, admit, and annotate width follow the Windows rules', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(admitLabel(0), 'Nobody waiting');
  assert.equal(admitLabel(1, 'Ava'), 'Admit Ava');
  assert.equal(admitLabel(3), 'Admit all 3 waiting');
  assert.equal(admitTone(0), 'idle');
  assert.equal(admitTone(2), 'warn');
  assert.equal(toolWidth('pen', 3), 3);
  assert.equal(toolWidth('hl', 3), 22);
  assert.equal(toolWidth('highlight', 1), 10);
  assert.equal(toolWidth('pen', 99), 12);
  assert.deepEqual(ANNOTATE_COLORS, ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#ffffff']);
  assert.deepEqual(ANNOTATE_GROUP_ORDER, ['draw', 'erase', 'color', 'perm']);
  assert.equal(flipOrient('horizontal'), 'vertical');
  assert.equal(flipOrient('vertical'), 'horizontal');
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

test('clampPanel keeps a floating tools panel inside its window', () => {
  assert.deepEqual(clampPanel({ x: -20, y: 10 }, { w: 100, h: 40 }, { w: 200, h: 100 }), { x: 0, y: 10 });
  assert.deepEqual(clampPanel({ x: 180, y: 90 }, { w: 100, h: 40 }, { w: 200, h: 100 }), { x: 100, y: 60 });
  assert.deepEqual(clampPanel({ x: Number.NaN, y: Number.NaN }, { w: 10, h: 10 }, { w: 50, h: 50 }), { x: 8, y: 8 });
});

test('annotate tools open under the share bar, right edges aligned', () => {
  const bar = { x: 100, y: 80, w: 400, h: 40 };
  const panel = { w: 280, h: 56 };
  const viewport = { w: 1280, h: 800 };
  // x = 100 + 400 - 280, y = 80 + 40 + 8
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport }), { x: 220, y: 128 });
  const placed = placeAnnotateTools({ bar, panel, viewport });
  assert.equal(placed.x + panel.w, bar.x + bar.w);
  assert.equal(placed.y, bar.y + bar.h + 8);
  assert.ok(placed.y >= bar.y + bar.h);
});

test('annotate tools flip above the bar when they would leave the viewport', () => {
  const bar = { x: 40, y: 500, w: 300, h: 40 };
  const panel = { w: 200, h: 80 };
  const viewport = { w: 800, h: 560 };
  // below: y = 548, 548 + 80 > 560, so above: y = 500 - 80 - 8
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport }), { x: 140, y: 412 });
  const placed = placeAnnotateTools({ bar, panel, viewport });
  assert.ok(placed.y + panel.h <= bar.y);
  assert.equal(placed.x + panel.w, bar.x + bar.w);
});

test('annotate tools clamp x into the viewport', () => {
  const bar = { x: 20, y: 80, w: 100, h: 36 };
  const panel = { w: 400, h: 50 };
  const viewport = { w: 360, h: 700 };
  // x = 20 + 100 - 400 = -280 → 0. Right edge still cannot pass the viewport.
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport }), { x: 0, y: 124 });
  const wide = placeAnnotateTools({
    bar: { x: 300, y: 40, w: 200, h: 36 },
    panel: { w: 180, h: 40 },
    viewport: { w: 400, h: 500 },
  });
  assert.equal(wide.x, 220);
  assert.ok(wide.x + 180 <= 400);
});

test('a saved annotate position is used only when the panel is fully inside the viewport', () => {
  const bar = { x: 100, y: 80, w: 400, h: 40 };
  const panel = { w: 100, h: 40 };
  const viewport = { w: 800, h: 600 };
  const fallback = { x: 400, y: 128 };
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport, saved: { x: 300, y: 200 } }), { x: 300, y: 200 });
  assert.equal(annotateToolsPosInside({ x: 300, y: 200 }, panel, viewport), true);
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport, saved: { x: 750, y: 200 } }), fallback);
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport, saved: { x: 10, y: 580 } }), fallback);
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport, saved: { x: -1, y: 10 } }), fallback);
  assert.deepEqual(placeAnnotateTools({ bar, panel, viewport, saved: { x: Number.NaN, y: 10 } }), fallback);
  assert.deepEqual(parseAnnotateToolsPos('{"x":12,"y":40}'), { x: 12, y: 40 });
  assert.equal(parseAnnotateToolsPos('nope'), null);
  assert.equal(parseAnnotateToolsPos(null), null);
});

test('automatic annotate placement stays off the class header and the share bar', () => {
  const bar = { x: 12, y: 72, w: 480, h: 40 };
  const panel = { w: 300, h: 56 };
  const viewport = { w: 1200, h: 800 };
  const headerBottom = 96;
  const placed = placeAnnotateTools({ bar, panel, viewport, headerBottom });
  assert.ok(placed.y >= headerBottom);
  assert.ok(placed.y >= bar.y + bar.h);
  assert.equal(placed.x + panel.w, bar.x + bar.w);
  // Short viewport: above the bar would cover the header, so stay below the bar.
  const tight = placeAnnotateTools({
    bar: { x: 40, y: 100, w: 300, h: 36 },
    panel: { w: 200, h: 80 },
    viewport: { w: 800, h: 200 },
    headerBottom: 90,
  });
  assert.ok(tight.y >= 90);
  assert.ok(tight.y >= 100 + 36);
  // No bar: not the old top-left (12, 48), and not over the header.
  const bare = placeAnnotateTools({ panel: { w: 100, h: 40 }, viewport: { w: 800, h: 600 }, headerBottom: 110 });
  assert.equal(bare.y, 110);
  assert.equal(bare.x, 800 - 100 - 16);
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
  const tools = src('components/classroom/AnnotateTools.tsx');
  assert.match(tools, /placeAnnotateTools\(/);
  assert.doesNotMatch(tools, /x: 12, y: 48/);
});

test('share pill, meeting bar, and video header are wired without dropping the older guards', () => {
  const hud = src('components/classroom/TeacherShareHud.tsx');
  assert.match(hud, /shareToolbarIds\(/);
  assert.match(hud, /aria-label=\{props\.stopLabel \?\? 'Stop sharing screen'\}/);
  assert.match(hud, /data-testid="share-inline-dock"/);
  assert.match(hud, /share_controls_v2/);
  assert.match(hud, /AnnotateTools/);
  assert.doesNotMatch(hud, /Share controls \(compact\)/);
  assert.doesNotMatch(hud, /aria-label="Low power/);
  assert.doesNotMatch(hud, /Send computer sound/);
  const room = classroomViewSource();
  assert.match(room, /minLeft=\{wbOpen \? WB_TOOL_CLEAR_PX : 0\}/);
  assert.match(room, /dock=\{wbOpen \? null : dockArea\}/);
  assert.match(room, /data-testid="video-panel-resize"/);
  assert.match(src('components/classroom/Controls.tsx'), /aria-label="Video panel"/);
  assert.match(room, /TeacherInkProvider/);
  assert.match(room, /videos-layout-/);
  assert.match(room, /!wbOpen && \(/);
  const host = src('components/classroom/Whiteboard.tsx');
  assert.match(host, /right: MEETING_BAR_PX/);
  assert.doesNotMatch(host, /wb-video-slot/);
});
