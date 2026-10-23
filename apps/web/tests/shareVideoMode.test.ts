import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCREEN_SHARE, SLIDES_MAX_FPS, shareEncodingsFor, shareProfile } from '../src/lib/videoQuality';

test('video mode: 720p / 24 fps caps, motion; slides keep sharp text', () => {
  const v = shareProfile(true);
  assert.equal(v.capture.frameRate.max, 24);
  assert.equal(v.capture.height?.max, 720);
  assert.equal(v.top.maxFramerate, 24);
  assert.equal(v.low.maxFramerate, 24);
  assert.equal(v.degradationPreference, 'maintain-resolution');
  assert.equal(v.contentHint, 'motion');
  const s = shareProfile(false);
  assert.equal(s.top.maxBitrate, SCREEN_SHARE.encoding.maxBitrate);
  // 2026-10-23: slides cap at 15 fps (capture and both layers).
  assert.equal(s.low.maxFramerate, SLIDES_MAX_FPS);
  assert.equal(s.top.maxFramerate, SLIDES_MAX_FPS);
  assert.equal(s.capture.frameRate.max, SLIDES_MAX_FPS);
  assert.equal(s.degradationPreference, 'maintain-resolution');
  assert.equal(s.contentHint, 'detail');
});

test('video mode stays phone-sane: low layer ≤ 1 Mbps, top ≤ 1.5 Mbps', () => {
  const v = shareProfile(true);
  assert.ok(v.low.maxBitrate <= 1_000_000);
  assert.ok(v.top.maxBitrate <= 1_500_000);
});

test('encodings: last is the top layer, other fields kept', () => {
  const enc = [
    { rid: 'q', active: true, scaleResolutionDownBy: 1.5, maxBitrate: 500_000, maxFramerate: 10 },
    { rid: 'h', active: false, scaleResolutionDownBy: 1, maxBitrate: 1_500_000, maxFramerate: 15 },
  ];
  const out = shareEncodingsFor(enc, true);
  assert.deepEqual(out[0], { rid: 'q', active: true, scaleResolutionDownBy: 1.5, maxBitrate: 1_000_000, maxFramerate: 24 });
  assert.deepEqual(out[1], { rid: 'h', active: false, scaleResolutionDownBy: 1, maxBitrate: 1_500_000, maxFramerate: 24 });
  const back = shareEncodingsFor(out, false);
  // Slides (default) share: 720p floor at 15 fps, top layer at the raised bitrate.
  assert.equal(back[0].maxFramerate, SLIDES_MAX_FPS);
  assert.equal(back[1].maxBitrate, 2_500_000);
  const single = shareEncodingsFor([{ maxBitrate: 1 }], true);
  assert.equal(single[0].maxBitrate, 1_500_000);
});
