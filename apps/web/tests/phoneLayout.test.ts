import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneLayout, phoneChatBox } from '../src/hooks/usePhoneLayout';

test('phone layouts by viewport', () => {
  assert.equal(phoneLayout(844, 390), 'landscape');
  assert.equal(phoneLayout(915, 412), 'landscape');
  assert.equal(phoneLayout(390, 844), 'portrait');
  assert.equal(phoneLayout(412, 915), 'portrait');
  assert.equal(phoneLayout(1200, 720), null);
  assert.equal(phoneLayout(768, 1024), null);
});

test('phone chat sheet is short (share and drawing stay visible)', () => {
  const cover = (b: { width: number; height: number }, w: number, h: number) => (b.width * b.height) / (w * h);
  for (const [w, h] of [
    [844, 390],
    [915, 412],
  ]) {
    const b = phoneChatBox('landscape', w, h)!;
    assert.ok(cover(b, w, h) <= 0.2, `landscape ${w}x${h} cover ${cover(b, w, h)}`);
    assert.ok(b.height >= 170 && b.width >= 200);
    assert.equal(b.y + b.height, h - 8);
  }
  for (const [w, h] of [
    [390, 844],
    [412, 915],
  ]) {
    const b = phoneChatBox('portrait', w, h)!;
    assert.ok(cover(b, w, h) <= 0.23, `portrait ${w}x${h} cover ${cover(b, w, h)}`);
    // Sits below a centred 16:9 share (letterbox), above the controls.
    const shareBottom = h / 2 + (w * 9) / 16 / 2;
    assert.ok(b.y >= shareBottom, `portrait ${w}x${h} sheet top ${b.y} vs share bottom ${shareBottom}`);
  }
  assert.equal(phoneChatBox(null, 1200, 720), null);
});
