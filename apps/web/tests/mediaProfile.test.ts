import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STUDENT_CAMERA,
  TEACHER_CAMERA,
  cameraProfile,
  mediaProfile,
  parseMediaProfile,
  screenShare,
  setMediaProfile,
  shareEncodingsFor,
  shareProfile,
} from '../src/lib/videoQuality';

test('MEDIA_PROFILE=low lowers every publisher bitrate; standard is unchanged', () => {
  assert.equal(parseMediaProfile(undefined), 'standard');
  assert.equal(parseMediaProfile(' LOW '), 'low');
  assert.equal(parseMediaProfile('ultra'), 'standard');
  setMediaProfile('standard');
  try {
    assert.equal(cameraProfile(true), TEACHER_CAMERA);
    assert.equal(cameraProfile(false), STUDENT_CAMERA);
    const std = { slides: shareProfile(false), video: shareProfile(true), share: screenShare() };
    setMediaProfile('low');
    assert.equal(mediaProfile(), 'low');
    assert.ok(cameraProfile(true).encoding.maxBitrate < TEACHER_CAMERA.encoding.maxBitrate);
    assert.equal(cameraProfile(true).simulcast, false);
    assert.ok(cameraProfile(false).encoding.maxBitrate < STUDENT_CAMERA.encoding.maxBitrate);
    assert.ok(shareProfile(false).top.maxBitrate < std.slides.top.maxBitrate);
    assert.ok(shareProfile(false).top.maxFramerate <= std.slides.top.maxFramerate);
    assert.ok(shareProfile(true).top.maxBitrate < std.video.top.maxBitrate);
    assert.ok(screenShare().encoding.maxBitrate < std.share.encoding.maxBitrate);
    // Re-applied encodings follow the active profile too.
    const enc = shareEncodingsFor([{ maxBitrate: 9 }, { maxBitrate: 9 }], false);
    assert.equal(enc[1]!.maxBitrate, shareProfile(false).top.maxBitrate);
    // Text stays sharp: resolution is kept, frames are dropped.
    assert.equal(shareProfile(false).degradationPreference, 'maintain-resolution');
  } finally {
    setMediaProfile('standard');
  }
});
