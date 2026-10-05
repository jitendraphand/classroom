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

test('phone chat sheet never covers the whole stage', () => {
  const land = phoneChatBox('landscape', 844, 390)!;
  assert.ok(land.width / 844 <= 0.46);
  const port = phoneChatBox('portrait', 390, 844)!;
  assert.ok(port.height / 844 <= 0.5);
  assert.equal(phoneChatBox(null, 1200, 720), null);
});
