import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFreezeShare, stillSize } from '../src/lib/shareFreeze';

test('only an annotated, non-previewable (entire-screen) share freezes', () => {
  assert.equal(shouldFreezeShare({ annotateOn: true, screenOn: true, surface: 'monitor', previewable: false }), true);
  assert.equal(shouldFreezeShare({ annotateOn: false, screenOn: true, surface: 'monitor', previewable: false }), false);
  assert.equal(shouldFreezeShare({ annotateOn: true, screenOn: true, surface: 'window', previewable: true }), false);
  assert.equal(shouldFreezeShare({ annotateOn: true, screenOn: false, surface: 'monitor', previewable: false }), false);
  assert.equal(shouldFreezeShare({ annotateOn: true, screenOn: true, surface: '', previewable: false }), false);
});

test('still size keeps the frame, capped at 1920 long side, even dimensions', () => {
  assert.deepEqual(stillSize(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(stillSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(stillSize(2560, 1600), { width: 1920, height: 1200 });
  assert.deepEqual(stillSize(0, 100), { width: 0, height: 0 });
});
