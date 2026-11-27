import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findFreeSpot, fitsAt } from '../src/lib/floatGeometry';

const vp = { w: 1024, h: 600 };
const insets = { left: 62, right: 54 };

test('a remembered spot is reused only when the panel still fits there whole', () => {
  assert.equal(fitsAt({ x: 100, y: 100 }, { w: 320, h: 420 }, vp, insets), true);
  // Remembered on a big screen: would hang off the bottom/right of a tablet.
  assert.equal(fitsAt({ x: 1500, y: 950 }, { w: 320, h: 420 }, vp, insets), false);
  assert.equal(fitsAt({ x: 100, y: 300 }, { w: 320, h: 420 }, vp, insets), false);
});

test('a new panel opens where it covers no other open panel', () => {
  const roster = { x: 66, y: 4, w: 320, h: 480 };
  const videos = { x: 752, y: 312, w: 210, h: 272 };
  const spot = findFreeSpot({ x: 684, y: 72 }, { w: 320, h: 420 }, vp, [roster, videos], insets);
  const box = { ...spot, w: 320, h: 420 };
  const hits = (a: typeof box, b: typeof roster) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
  assert.equal(hits(box, roster), false);
  assert.equal(hits(box, videos), false);
  // Inside the free area (clear of the tool column and the meeting bar).
  assert.ok(spot.x >= 62 && spot.x + 320 <= 1024 - 54 && spot.y >= 0 && spot.y + 420 <= 600);
  // Nothing open: the wanted spot is kept.
  assert.deepEqual(findFreeSpot({ x: 600, y: 72 }, { w: 320, h: 420 }, vp, [], insets), { x: 600, y: 72 });
  // No free room at all: still on screen (least covered).
  const full = [{ x: 0, y: 0, w: 1024, h: 600 }];
  const p = findFreeSpot({ x: 5000, y: 5000 }, { w: 320, h: 420 }, vp, full, insets);
  assert.ok(p.x + 320 <= 1024 && p.y + 420 <= 600);
});

test('floats: fit check, free spot and bring-to-front are wired; whiteboard panels clear the side bars', () => {
  const fp = readFileSync('src/components/classroom/FloatingPanel.tsx', 'utf8');
  assert.match(fp, /if \(stored && !fitsAt\(stored, size, viewportSize\(\), insets\)\) want = defaultRef\.current\(\);/);
  assert.match(fp, /want = findFreeSpot\(want, size, viewportSize\(\), otherFloatRects\(el\), insets\);/);
  assert.match(fp, /el\.addEventListener\('pointerdown', front, true\)/);
  assert.doesNotMatch(fp, /floatStack\.splice\(i, 1\);\n\s+\};\n\s+\}\);/); // a re-render must not drop the pane
  const room = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  assert.equal((room.match(/extraInsets=\{wbOpen \? wbFloatInsets : undefined\}/g) || []).length, 2);
  assert.match(room, /y: wbOpen \? 72 : Math\.max\(8, window\.innerHeight - 540\)/);
});
