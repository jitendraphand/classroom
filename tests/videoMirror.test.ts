import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHARE_MIRROR_FPS, SHARE_MIRROR_GAP_MS, shouldEmitMirrorFrame } from '../src/renderer/videoMirror';

test('share tiles send about 8 frames a second', () => {
  assert.equal(SHARE_MIRROR_FPS, 8);
  assert.equal(SHARE_MIRROR_GAP_MS, 125);
  assert.equal(shouldEmitMirrorFrame(1000, 0), true);
  assert.equal(shouldEmitMirrorFrame(100, 0), false);
  assert.equal(shouldEmitMirrorFrame(125, 0), true);
  assert.equal(shouldEmitMirrorFrame(124, 0), false);
});
