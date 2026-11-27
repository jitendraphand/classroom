import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shareToolbarMiniIds } from '../src/lib/shareChrome';
import {
  FREEZE_LOOKBACK_MS,
  FROZEN_RESEND_MS,
  MASK_MARGIN_DIP,
  UNFREEZE_HOLD_MS,
  classTabOnCapturedScreen,
} from '../src/lib/screenMask';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const fhd = { width: 1920, height: 1080 };
const left = { left: 0, top: 0, width: 1920, height: 1080 };
const right4k = { left: 1920, top: 0, width: 2560, height: 1600 };

test('mini share toolbar: the smallest useful set', () => {
  assert.deepEqual(shareToolbarMiniIds(), ['live', 'mic', 'hands', 'chat', 'more', 'stop']);
  const hud = src('components/classroom/TeacherShareHud.tsx');
  assert.match(hud, /data-testid="hud-more"/);
  assert.match(hud, /const miniMode = mini && !inline/);
  // A click in the expanded row folds it back while the window may still resize.
  assert.match(hud, /onClickCapture=/);
  assert.match(hud, /\{miniMode \? null : 'Stop'\}/);
  assert.match(classroomViewSource(), /mini=\{maskActive\}/);
});

test('black patch margin is 8 DIPs', () => {
  assert.equal(MASK_MARGIN_DIP, 8);
});

test('freeze only when the class tab is on the captured screen', () => {
  const tab = (x: number) => ({ x, y: 500 });
  // One display: the class tab is always on the shared screen.
  assert.equal(classTabOnCapturedScreen({ isExtended: false, screens: null, tabCenter: tab(5000), frame: fhd }), true);
  // Several displays, layout unknown: never freeze (students keep a live picture).
  assert.equal(classTabOnCapturedScreen({ isExtended: true, screens: null, tabCenter: tab(500), frame: fhd }), false);
  assert.equal(classTabOnCapturedScreen({ isExtended: undefined, screens: null, tabCenter: tab(500), frame: fhd }), false);
  // Shared 1080p screen on the left; class tab on the left → freeze, on the right → live.
  const screens = [left, right4k];
  assert.equal(classTabOnCapturedScreen({ isExtended: true, screens, tabCenter: tab(800), frame: fhd }), true);
  assert.equal(classTabOnCapturedScreen({ isExtended: true, screens, tabCenter: tab(2500), frame: fhd }), false);
  assert.ok(FREEZE_LOOKBACK_MS > 0 && UNFREEZE_HOLD_MS > 0 && FROZEN_RESEND_MS >= 500);
});

test('freeze is wired into the entire-screen share and explained to the teacher', () => {
  const room = classroomViewSource();
  assert.match(room, /frozen: shouldFreeze/);
  assert.match(room, /data-testid="share-freeze-note"/);
  const pipe = src('lib/screenMaskPipeline.ts');
  assert.match(pipe, /frozen\?: \(\) => boolean/);
  // Every frame leaves through emit(), the only place that enqueues.
  assert.equal(pipe.match(/controller\.enqueue\(/g)?.length, 2);
  assert.match(pipe, /emit\(controller, /);
});

test('students can draw on the whiteboard only, never on a screen share', () => {
  const route = src('app/api/rooms/[code]/draw/route.ts');
  assert.match(route, /async function whiteboardOpen\(/);
  assert.match(route, /Students can draw on the whiteboard only\./);
  assert.doesNotMatch(route, /function sharing\(/);
  const room = classroomViewSource();
  assert.match(room, /const myDrawState: 'off' \| 'drawing' = state\?\.me\?\.canDraw \? 'drawing' : 'off';/);
  for (const f of ['components/classroom/AnnotateTools.tsx', 'components/classroom/TeacherInk.tsx', 'components/classroom/ShareDrawing.tsx', 'lib/teacherInk.ts']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', f)), false, f);
  }
});
