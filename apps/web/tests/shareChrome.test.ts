import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANNOTATE_COLORS,
  ANNOTATE_GROUP_ORDER,
  MEETING_BAR_ORDER,
  MEETING_BAR_PX,
  OMITTED_SHARE_CONTROLS,
  SHARE_TOOLBAR_ORDER,
  admitLabel,
  admitTone,
  badgeText,
  clampPanel,
  flipOrient,
  focusAlertDanger,
  meetingBarIds,
  peopleBadgeCount,
  shareToolbarIds,
  shareToolbarSeparators,
  toolWidth,
} from '../src/lib/shareChrome';

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
  const room = src('components/classroom/ClassroomRoom.tsx');
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
