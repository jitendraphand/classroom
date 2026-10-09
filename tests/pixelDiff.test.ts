import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelPixelDiff } from '../src/shared/pixelDiff';
import { pointInContent } from '../src/shared/annotate';

test('pixel diff passes when the panel region matches the hidden-panel reference', () => {
  const width = 8;
  const height = 4;
  const reference = new Uint8Array(width * height * 4);
  reference.fill(40);
  const same = panelPixelDiff(reference, reference, width, height, [{ x: 1, y: 1, w: 3, h: 2 }]);
  assert.equal(same.pass, true);
  assert.equal(same.changed, 0);
  const live = new Uint8Array(reference);
  live[0] = 255;
  live[1] = 0;
  live[2] = 0;
  const shifted = panelPixelDiff(reference, live, width, height, [{ x: 0, y: 0, w: 2, h: 2 }]);
  assert.equal(shifted.pass, false);
  assert.ok(shifted.changed >= 1);
});

test('annotation stays 0-1 at 125% and 150% because the pointer and the box are CSS pixels', () => {
  const content = { x: 10, y: 20, w: 800, h: 450 };
  const pointer = { x: 410, y: 245 };
  const norm = pointInContent(pointer, content);
  assert.equal(norm?.[0], 0.5);
  assert.equal(norm?.[1], 0.5);
  for (const scale of [1, 1.25, 1.5]) {
    const mapped = pointInContent(
      { x: (pointer.x * scale) / scale, y: (pointer.y * scale) / scale },
      { x: (content.x * scale) / scale, y: (content.y * scale) / scale, w: (content.w * scale) / scale, h: (content.h * scale) / scale }
    );
    assert.deepEqual(mapped, norm);
  }
});
