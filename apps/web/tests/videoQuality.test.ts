import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraProfile,
  SCREEN_SHARE,
  screenShareSimulcastFor,
  STUDENT_CAMERA,
  TEACHER_CAMERA,
  SHARE_CODEC,
  shareUsesVp9,
  shareProfile,
} from '../src/lib/videoQuality';

test('teacher camera: 360p single layer, 15 fps, ≤300 kbps', () => {
  assert.equal(TEACHER_CAMERA.capture.width.ideal, 640);
  assert.equal(TEACHER_CAMERA.capture.height.ideal, 360);
  assert.equal(TEACHER_CAMERA.capture.frameRate.max, 15);
  assert.equal(TEACHER_CAMERA.simulcast, false);
  assert.ok(TEACHER_CAMERA.encoding.maxBitrate <= 300_000);
});

test('student camera: small, ~15 fps, low bitrate, single layer', () => {
  assert.ok(STUDENT_CAMERA.capture.width.ideal <= 320);
  assert.ok(STUDENT_CAMERA.capture.height.ideal <= 240);
  assert.equal(STUDENT_CAMERA.encoding.maxFramerate, 15);
  assert.ok(STUDENT_CAMERA.encoding.maxBitrate >= 150_000 && STUDENT_CAMERA.encoding.maxBitrate <= 250_000);
  assert.equal(STUDENT_CAMERA.simulcast, false);
});

test('screen share: slides ≤8 fps, 1080p top, 720p floor layer', () => {
  assert.equal(SCREEN_SHARE.capture.height.ideal, 1080);
  assert.equal(SCREEN_SHARE.capture.frameRate.max, 8);
  assert.equal(SCREEN_SHARE.encoding.maxFramerate, 8);
  assert.equal(SCREEN_SHARE.layers.length, 1);
  assert.ok(Math.min(SCREEN_SHARE.layers[0].width, SCREEN_SHARE.layers[0].height) >= 720);
});

test('share codec: VP9 L1T3 (frame rate degrades, never resolution) with VP8 backup on Chromium only', () => {
  assert.equal(SHARE_CODEC.codec, 'vp9');
  assert.equal(SHARE_CODEC.scalabilityMode, 'L1T3');
  assert.equal(SHARE_CODEC.backupCodec, 'vp8');
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const edge = chrome + ' Edg/130.0';
  const ff = 'Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0';
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const ios = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
  assert.equal(shareUsesVp9(chrome), true);
  assert.equal(shareUsesVp9(edge), true);
  assert.equal(shareUsesVp9(ff), false);
  assert.equal(shareUsesVp9(safari), false);
  assert.equal(shareUsesVp9(ios), false);
  assert.equal(shareUsesVp9(''), false);
});

test('slides keep resolution under pressure (maintain-resolution, detail)', () => {
  const s = shareProfile(false);
  assert.equal(s.degradationPreference, 'maintain-resolution');
  assert.equal(s.contentHint, 'detail');
});

test('screen share simulcasts only when the capture is clearly bigger than the low layer', () => {
  assert.equal(screenShareSimulcastFor(1920, 1080), true);
  assert.equal(screenShareSimulcastFor(1440, 900), true); // Safari-like logical capture
  assert.equal(screenShareSimulcastFor(2880, 1800), true);
  assert.equal(screenShareSimulcastFor(1080, 1920), true); // portrait
  assert.equal(screenShareSimulcastFor(1280, 720), false); // same as the low layer
  assert.equal(screenShareSimulcastFor(1366, 768), false); // would be ~1.07x: not worth a second encode
  assert.equal(screenShareSimulcastFor(800, 600), false); // small window share
  assert.equal(screenShareSimulcastFor(undefined, undefined), false); // unknown → single layer
  assert.equal(screenShareSimulcastFor(1920, 0), false);
});

test('camera profile by role', () => {
  assert.equal(cameraProfile(true), TEACHER_CAMERA);
  assert.equal(cameraProfile(false), STUDENT_CAMERA);
});
