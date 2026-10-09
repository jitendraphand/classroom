import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIRROR_STALL_MS,
  SHARE_MIRROR_FPS,
  SHARE_MIRROR_GAP_MS,
  mirrorSize,
  shouldEmitMirrorFrame,
  sinkNeedsRestart,
} from '../src/renderer/videoMirror';

test('share tiles follow the 15 fps student camera', () => {
  assert.equal(SHARE_MIRROR_FPS, 15);
  assert.equal(SHARE_MIRROR_GAP_MS, 67);
  assert.equal(shouldEmitMirrorFrame(1000, 0), true);
  // A 15 fps camera (66.7 ms apart) is not halved by rounding.
  assert.equal(shouldEmitMirrorFrame(66.7, 0), true);
  assert.equal(shouldEmitMirrorFrame(40, 0), false);
});

test('tile pictures keep the camera aspect inside 320x180', () => {
  assert.deepEqual(mirrorSize(640, 360), { w: 320, h: 180 });
  assert.deepEqual(mirrorSize(640, 480), { w: 240, h: 180 });
  assert.deepEqual(mirrorSize(160, 90), { w: 160, h: 90 });
  assert.deepEqual(mirrorSize(0, 0), { w: 320, h: 180 });
});

test('watchdog reopens dead or stalled pumps of live, unmuted tracks only', () => {
  const base = { dead: false, lastFrameAt: 1000, openedAt: 0, now: 1000 + MIRROR_STALL_MS + 1, trackLive: true, trackMuted: false };
  assert.equal(sinkNeedsRestart(base), true);
  assert.equal(sinkNeedsRestart({ ...base, now: 1500 }), false);
  assert.equal(sinkNeedsRestart({ ...base, trackMuted: true }), false);
  assert.equal(sinkNeedsRestart({ ...base, trackLive: false }), false);
  assert.equal(sinkNeedsRestart({ ...base, now: 1500, dead: true }), true);
  // A fresh pump gets the full grace period before its first frame.
  assert.equal(sinkNeedsRestart({ ...base, lastFrameAt: 0, openedAt: 5000, now: 6000 }), false);
});
