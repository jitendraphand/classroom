import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraProfile, SCREEN_SHARE, STUDENT_CAMERA, TEACHER_CAMERA } from '../src/lib/videoQuality';

test('teacher camera: 720p capture, 24–30 fps, simulcast with a ~180p low layer', () => {
  assert.equal(TEACHER_CAMERA.capture.width.ideal, 1280);
  assert.equal(TEACHER_CAMERA.capture.height.ideal, 720);
  assert.ok(TEACHER_CAMERA.capture.frameRate.ideal >= 24 && TEACHER_CAMERA.capture.frameRate.ideal <= 30);
  assert.equal(TEACHER_CAMERA.simulcast, true);
  assert.ok(TEACHER_CAMERA.encoding.maxBitrate >= 1_200_000 && TEACHER_CAMERA.encoding.maxBitrate <= 1_700_000);
  const [low, mid] = TEACHER_CAMERA.layers;
  assert.deepEqual([low.width, low.height], [320, 180]);
  assert.ok(low.maxBitrate >= 120_000 && low.maxBitrate <= 150_000);
  assert.deepEqual([mid.width, mid.height], [640, 360]);
  // Layers strictly increase in size and bitrate up to the top layer.
  assert.ok(low.maxBitrate < mid.maxBitrate && mid.maxBitrate < TEACHER_CAMERA.encoding.maxBitrate);
  assert.ok(mid.maxFramerate <= TEACHER_CAMERA.encoding.maxFramerate);
});

test('student camera: small, ~15 fps, low bitrate, single layer', () => {
  assert.ok(STUDENT_CAMERA.capture.width.ideal <= 320);
  assert.ok(STUDENT_CAMERA.capture.height.ideal <= 240);
  assert.equal(STUDENT_CAMERA.encoding.maxFramerate, 15);
  assert.ok(STUDENT_CAMERA.encoding.maxBitrate >= 150_000 && STUDENT_CAMERA.encoding.maxBitrate <= 250_000);
  assert.equal(STUDENT_CAMERA.simulcast, false);
});

test('screen share unchanged: 1080p ideal, 1.5 Mbps, 15 fps, no simulcast', () => {
  assert.equal(SCREEN_SHARE.capture.width.ideal, 1920);
  assert.equal(SCREEN_SHARE.encoding.maxBitrate, 1_500_000);
  assert.equal(SCREEN_SHARE.encoding.maxFramerate, 15);
  assert.equal(SCREEN_SHARE.simulcast, false);
});

test('camera profile by role', () => {
  assert.equal(cameraProfile(true), TEACHER_CAMERA);
  assert.equal(cameraProfile(false), STUDENT_CAMERA);
});
