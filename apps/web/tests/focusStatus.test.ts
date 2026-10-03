import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFocusStatus,
  countFocusAlerts,
  decodeFocus,
  encodeFocus,
  focusLabel,
  isFocusAlert,
  isIPhoneUA,
  needsCover,
  parseFocusStatus,
} from '../src/lib/focusStatus';

test('status: hidden wins, then support, then fullscreen', () => {
  assert.equal(computeFocusStatus({ fullscreenSupported: true, isFullscreen: true, hidden: false }), 'fullscreen');
  assert.equal(computeFocusStatus({ fullscreenSupported: true, isFullscreen: false, hidden: false }), 'left');
  assert.equal(computeFocusStatus({ fullscreenSupported: true, isFullscreen: true, hidden: true }), 'away');
  assert.equal(computeFocusStatus({ fullscreenSupported: false, isFullscreen: false, hidden: false }), 'unsupported');
  assert.equal(computeFocusStatus({ fullscreenSupported: false, isFullscreen: false, hidden: true }), 'away');
});

test('cover only for left / away; iPhone focus mode is never covered', () => {
  assert.equal(needsCover('left'), true);
  assert.equal(needsCover('away'), true);
  assert.equal(needsCover('fullscreen'), false);
  assert.equal(needsCover('unsupported'), false);
});

test('iPhone detection excludes iPad', () => {
  assert.equal(isIPhoneUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isIPhoneUA('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15'), false);
  assert.equal(isIPhoneUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'), false);
  assert.equal(isIPhoneUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129 Mobile Safari/537.36'), false);
});

test('teacher labels: iPhone is informational, not an alert', () => {
  assert.equal(focusLabel('left'), 'Left fullscreen');
  assert.equal(focusLabel('away'), 'Switched away');
  assert.equal(focusLabel('unsupported', true), 'iPhone - fullscreen not supported');
  assert.equal(focusLabel('fullscreen'), null);
  assert.equal(focusLabel(undefined), null);
  assert.equal(isFocusAlert('unsupported'), false);
  assert.equal(
    countFocusAlerts([{ focus: 'left' }, { focus: 'away' }, { focus: 'unsupported' }, { focus: 'fullscreen' }, {}]),
    2
  );
});

test('stored value round-trips and rejects junk', () => {
  assert.deepEqual(decodeFocus(encodeFocus('unsupported', true, 1)), { focus: 'unsupported', iphone: true });
  assert.deepEqual(decodeFocus(encodeFocus('left', false, 1)), { focus: 'left', iphone: false });
  assert.equal(decodeFocus('{"s":"gone"}'), null);
  assert.equal(decodeFocus('nope'), null);
  assert.equal(decodeFocus(null), null);
  assert.equal(parseFocusStatus('away'), 'away');
  assert.equal(parseFocusStatus(3), null);
});
