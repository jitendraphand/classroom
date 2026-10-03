import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFloat,
  isDrag,
  parseStoredPos,
  shareControlsPlacement,
  showLocalSharePreview,
} from '../src/lib/floatGeometry';

const vp = { w: 800, h: 400 };

test('clampFloat keeps a panel inside the viewport and below the header', () => {
  const insets = { top: 90, bottom: 60 };
  assert.deepEqual(clampFloat({ x: -50, y: 0 }, { w: 200, h: 100 }, vp, insets), { x: 4, y: 94 });
  assert.deepEqual(clampFloat({ x: 900, y: 900 }, { w: 200, h: 100 }, vp, insets), { x: 596, y: 236 });
  assert.deepEqual(clampFloat({ x: 300, y: 150 }, { w: 200, h: 100 }, vp, insets), { x: 300, y: 150 });
});

test('a panel taller than the free area is pinned to the top so its header stays reachable', () => {
  const p = clampFloat({ x: 10, y: 300 }, { w: 300, h: 600 }, vp, { top: 90, bottom: 60 });
  assert.equal(p.y, 94);
});

test('clampFloat survives NaN input', () => {
  assert.deepEqual(clampFloat({ x: NaN, y: NaN }, { w: 10, h: 10 }, vp), { x: 4, y: 4 });
});

test('isDrag needs a 4px move so taps stay taps', () => {
  assert.equal(isDrag(2, 2), false);
  assert.equal(isDrag(3, 3), true);
});

test('parseStoredPos rejects junk', () => {
  assert.deepEqual(parseStoredPos('{"x":10,"y":20}'), { x: 10, y: 20 });
  assert.equal(parseStoredPos('{"x":"a"}'), null);
  assert.equal(parseStoredPos('nope'), null);
  assert.equal(parseStoredPos(null), null);
});

test('entire-screen capture keeps the share controls in the page', () => {
  assert.equal(shareControlsPlacement('monitor'), 'inline');
  assert.equal(shareControlsPlacement('window'), 'floating');
  assert.equal(shareControlsPlacement('browser'), 'floating');
  // Unknown surface fails closed.
  assert.equal(shareControlsPlacement(''), 'inline');
  assert.equal(shareControlsPlacement(undefined), 'inline');
});

test('teacher stage previews only window/tab shares (no recursive tunnel)', () => {
  assert.equal(showLocalSharePreview('window'), true);
  assert.equal(showLocalSharePreview('browser'), true);
  assert.equal(showLocalSharePreview('monitor'), false);
  assert.equal(showLocalSharePreview(''), false);
  assert.equal(showLocalSharePreview(undefined), false);
});
