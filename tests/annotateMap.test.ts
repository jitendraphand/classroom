import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientToDip, containContentRect, pointInContent, pointOnSurface } from '../src/shared/annotate';

test('a point on a monitor left of the primary maps into that monitor', () => {
  const surface = { x: -1920, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(pointOnSurface({ x: -960, y: 540 }, surface), [0.5, 0.5]);
  assert.deepEqual(pointOnSurface({ x: -1920, y: 0 }, surface), [0, 0]);
  assert.deepEqual(pointOnSurface({ x: 0, y: 1080 }, surface), [1, 1]);
});

test('client pixels plus the window DIP origin are the screen point', () => {
  assert.deepEqual(clientToDip({ x: 100, y: 50 }, { x: -1920, y: 0 }), { x: -1820, y: 50 });
});

test('overlay: the window sits on the shared surface, so client plus origin is 0–1', () => {
  const surface = { x: -1920, y: 0, w: 1920, h: 1080 };
  const dip = clientToDip({ x: 960, y: 540 }, { x: surface.x, y: surface.y });
  assert.deepEqual(pointOnSurface(dip, surface), [0.5, 0.5]);
});

test('region: the drag is 0–1 of the region, not of the whole monitor', () => {
  const region = { x: 100, y: 80, w: 400, h: 200 };
  const dip = clientToDip({ x: 200, y: 50 }, { x: region.x, y: region.y });
  assert.deepEqual(pointOnSurface(dip, region), [0.5, 0.25]);
  const outside = pointOnSurface(clientToDip({ x: -50, y: 400 }, { x: region.x, y: region.y }), region);
  assert.deepEqual(outside, [0, 1]);
});

test('letterboxed preview content is empty until the video intrinsic size is known', () => {
  const frame = { x: 0, y: 0, w: 960, h: 540 };
  const videoBox = { x: 0, y: 36, w: 960, h: 504 };
  assert.deepEqual(containContentRect(frame, videoBox, 0, 0), { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(pointInContent({ x: 10, y: 10 }, { x: 0, y: 0, w: 0, h: 0 }), null);
  const content = containContentRect(frame, videoBox, 1920, 1080);
  assert.ok(content.w > 0 && content.h > 0);
  assert.ok(content.w < videoBox.w);
  assert.ok(Math.abs(content.h - videoBox.h) < 0.01);
  assert.deepEqual(pointInContent({ x: content.x, y: content.y }, content), [0, 0]);
  assert.deepEqual(
    pointInContent({ x: content.x + content.w / 2, y: content.y + content.h / 2 }, content),
    [0.5, 0.5]
  );
});

test('a matching 16:9 preview has no letterbox, so the corner is the origin', () => {
  const frame = { x: 10, y: 20, w: 320, h: 180 };
  const videoBox = { x: 10, y: 20, w: 320, h: 180 };
  const content = containContentRect(frame, videoBox, 1920, 1080);
  assert.equal(content.x, 0);
  assert.equal(content.y, 0);
  assert.equal(content.w, 320);
  assert.equal(content.h, 180);
});
