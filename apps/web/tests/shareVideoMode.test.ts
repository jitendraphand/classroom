import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCREEN_SHARE, shareEncodingsFor, shareProfile } from '../src/lib/videoQuality';

test('video mode prefers 30 fps and motion; slides keep sharp text', () => {
  const v = shareProfile(true);
  assert.equal(v.capture.frameRate.ideal, 30);
  assert.equal(v.top.maxFramerate, 30);
  assert.equal(v.low.maxFramerate, 30);
  assert.equal(v.degradationPreference, 'maintain-framerate');
  assert.equal(v.contentHint, 'motion');
  const s = shareProfile(false);
  assert.equal(s.top.maxBitrate, SCREEN_SHARE.encoding.maxBitrate);
  assert.equal(s.low.maxFramerate, SCREEN_SHARE.layers[0].maxFramerate);
  assert.equal(s.degradationPreference, 'maintain-resolution');
  assert.equal(s.contentHint, 'detail');
});

test('video mode stays phone-sane: low layer ≤ 1 Mbps, top ≤ 2.5 Mbps', () => {
  const v = shareProfile(true);
  assert.ok(v.low.maxBitrate <= 1_000_000);
  assert.ok(v.top.maxBitrate <= 2_500_000);
});

test('encodings: last is the top layer, other fields kept', () => {
  const enc = [
    { rid: 'q', active: true, scaleResolutionDownBy: 1.5, maxBitrate: 500_000, maxFramerate: 10 },
    { rid: 'h', active: false, scaleResolutionDownBy: 1, maxBitrate: 1_500_000, maxFramerate: 15 },
  ];
  const out = shareEncodingsFor(enc, true);
  assert.deepEqual(out[0], { rid: 'q', active: true, scaleResolutionDownBy: 1.5, maxBitrate: 1_000_000, maxFramerate: 30 });
  assert.deepEqual(out[1], { rid: 'h', active: false, scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: 30 });
  const back = shareEncodingsFor(out, false);
  assert.equal(back[0].maxFramerate, 10);
  assert.equal(back[1].maxBitrate, 1_500_000);
  const single = shareEncodingsFor([{ maxBitrate: 1 }], true);
  assert.equal(single[0].maxBitrate, 2_500_000);
});
