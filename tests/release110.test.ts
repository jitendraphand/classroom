import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, updateNotice, updateText } from '../src/shared/update';
import { SCREEN_SHARE, VIDEO_MODE_SHARE, parseProfile, teacherCameraFor, videoModeShare, windowsShareEncodings } from '../src/shared/capture';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('update notice from the server: required below minimum, available below latest', () => {
  assert.equal(compareVersions('1.1.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), null);
  const info = { latest: '1.2.0', minimum: '1.1.0', url: 'https://example.com/dl' };
  assert.equal(updateNotice(info, '1.0.0').level, 'required');
  assert.equal(updateNotice(info, '1.1.0').level, 'available');
  assert.equal(updateNotice(info, '1.2.0').level, 'none');
  assert.match(updateText(updateNotice(info, '1.0.0')), /no longer supported.*1\.2\.0/);
  // Only an https download link; an older server (404 / junk) gives no notice.
  assert.equal(updateNotice({ ...info, url: 'http://example.com/dl' }, '1.0.0').url, null);
  assert.equal(updateNotice(null, '1.0.0').level, 'none');
});

test('server media profile: low caps Video mode and the camera like the web app', () => {
  assert.equal(parseProfile('low'), 'low');
  assert.equal(parseProfile(undefined), 'standard');
  assert.deepEqual(videoModeShare('standard'), VIDEO_MODE_SHARE);
  assert.equal(videoModeShare('low').encoding.maxBitrate, 800_000);
  assert.equal(videoModeShare('low').encoding.maxFramerate, 15);
  assert.equal(teacherCameraFor('low').encoding.maxBitrate, 120_000);
  assert.equal(teacherCameraFor('low').capture.height, 180);
  const [video] = windowsShareEncodings([{}], true, 'low');
  assert.deepEqual(video, { maxBitrate: 800_000, maxFramerate: 15 });
  // Slides are already under the web's low cap (10 fps / 1 Mbps).
  assert.ok(SCREEN_SHARE.encoding.maxBitrate <= 1_000_000 && SCREEN_SHARE.encoding.maxFramerate <= 10);
  // The class reads the profile from the token and hands it to the sidecar.
  assert.match(src('renderer/classSession.ts'), /this\.mediaProfile = parseProfile\(body\.mediaProfile\)/);
  assert.match(src('renderer/classSession.ts'), /profile: this\.mediaProfile/);
  assert.match(src('main/main.ts'), /videoModeShare\(parseProfile\(sideReq\?\.profile\)\)/);
});

test('the session is renewed in the background (sliding 24 h server sessions)', () => {
  const main = src('main/main.ts');
  assert.match(main, /setInterval\(renewSession, SESSION_RENEW_MS\)/);
  assert.match(main, /api\.call\('GET', '\/api\/auth\/me'\)/);
});
