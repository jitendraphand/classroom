import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aspectMatches,
  candidateScreens,
  planMask,
  RectTrail,
  unionRect,
  validWindowRect,
  windowRectOnFrame,
} from '../src/lib/screenMask';

const fhd = { width: 1920, height: 1080 };

test('1:1 screen → frame: window rect plus margin', () => {
  const r = windowRectOnFrame({ x: 100, y: 200, w: 250, h: 44 }, { left: 0, top: 0, width: 1920, height: 1080 }, fhd, 16);
  assert.deepEqual(r, { x: 84, y: 184, w: 282, h: 76 });
});

test('HiDPI / downscaled capture: DIPs scale by frame/screen ratio', () => {
  // 2560x1440 DIP screen captured at 1920x1080 → 0.75.
  const r = windowRectOnFrame({ x: 1000, y: 400, w: 200, h: 40 }, { left: 0, top: 0, width: 2560, height: 1440 }, fhd, 16);
  assert.deepEqual(r, { x: 738, y: 288, w: 174, h: 54 });
  // 1280x720 DIP screen at devicePixelRatio 2 captured at 2560x1440 → 2.
  const r2 = windowRectOnFrame({ x: 10, y: 10, w: 100, h: 50 }, { left: 0, top: 0, width: 1280, height: 720 }, { width: 2560, height: 1440 }, 0);
  assert.deepEqual(r2, { x: 20, y: 20, w: 200, h: 100 });
});

test('multi-monitor: offsets of the captured screen are subtracted', () => {
  const right = { left: 1920, top: 0, width: 1920, height: 1080 };
  assert.deepEqual(windowRectOnFrame({ x: 2000, y: 100, w: 100, h: 40 }, right, fhd, 0), { x: 80, y: 100, w: 100, h: 40 });
  // Monitor above the primary (negative top).
  const above = { left: 0, top: -1080, width: 1920, height: 1080 };
  assert.deepEqual(windowRectOnFrame({ x: 50, y: -1000, w: 100, h: 40 }, above, fhd, 0), { x: 50, y: 80, w: 100, h: 40 });
  // Window on another monitor → nothing on this frame.
  assert.equal(windowRectOnFrame({ x: 100, y: 100, w: 100, h: 40 }, right, fhd, 16), null);
});

test('clamps to the frame when the window hangs off the edge', () => {
  const r = windowRectOnFrame({ x: -50, y: 1060, w: 200, h: 100 }, { left: 0, top: 0, width: 1920, height: 1080 }, fhd, 16);
  assert.deepEqual(r, { x: 0, y: 1044, w: 166, h: 36 });
});

test('aspect check picks possible captured screens', () => {
  const screens = [
    { left: 0, top: 0, width: 1920, height: 1080 },
    { left: 1920, top: 0, width: 1280, height: 1024 },
  ];
  assert.equal(aspectMatches(screens[0]!, fhd), true);
  assert.equal(aspectMatches(screens[1]!, fhd), false);
  assert.deepEqual(candidateScreens(screens, fhd), [screens[0]]);
});

test('planMask: ambiguous identical monitors mask both spots; bad geometry is unsafe', () => {
  const screens = [
    { left: 0, top: 0, width: 1920, height: 1080 },
    { left: 1920, top: 0, width: 1920, height: 1080 },
  ];
  const plan = planMask({ x: 100, y: 100, w: 200, h: 40 }, screens, fhd, 0);
  assert.equal(plan.kind, 'rects');
  if (plan.kind === 'rects') assert.equal(plan.rects.length, 1, 'only the screen the window is on intersects');
  assert.deepEqual(planMask({ x: 0, y: 0, w: 0, h: 0 }, screens, fhd).kind, 'unsafe');
  assert.deepEqual(planMask(null, screens, fhd).kind, 'unsafe');
  assert.deepEqual(planMask({ x: 1, y: 1, w: 10, h: 10 }, [{ left: 0, top: 0, width: 1280, height: 1024 }], fhd).kind, 'unsafe');
  assert.equal(validWindowRect({ x: NaN, y: 0, w: 1, h: 1 }), false);
});

test('trail keeps recent rects so a fast drag stays covered', () => {
  const trail = new RectTrail(300);
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 100, y: 0, w: 10, h: 10 };
  assert.equal(trail.push(0, [a]).length, 1);
  assert.equal(trail.push(100, [b]).length, 2);
  assert.deepEqual(trail.push(500, [b]), [b], "old rects expire");
  assert.deepEqual(unionRect([a, b]), { x: 0, y: 0, w: 110, h: 10 });
  assert.equal(unionRect([]), null);
});
