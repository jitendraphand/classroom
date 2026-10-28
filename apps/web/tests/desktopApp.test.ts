import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsAppInfo } from '../src/lib/desktopApp';

test('Windows app update info: valid versions and an https link only', () => {
  assert.deepEqual(windowsAppInfo({}), { latest: null, minimum: null, url: null });
  assert.deepEqual(
    windowsAppInfo({ WINDOWS_APP_LATEST: ' 1.1.0 ', WINDOWS_APP_MINIMUM: '1.0.0', WINDOWS_APP_URL: 'https://example.com/dl' }),
    { latest: '1.1.0', minimum: '1.0.0', url: 'https://example.com/dl' }
  );
  assert.deepEqual(
    windowsAppInfo({ WINDOWS_APP_LATEST: 'v1.1', WINDOWS_APP_MINIMUM: 'latest', WINDOWS_APP_URL: 'http://example.com/dl' }),
    { latest: null, minimum: null, url: null }
  );
  assert.equal(windowsAppInfo({ WINDOWS_APP_URL: 'https://user:pw@example.com/' }).url, null);
});
