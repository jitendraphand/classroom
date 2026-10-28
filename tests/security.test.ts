import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_HOTKEYS,
  LEGACY_DEFAULT_HOTKEYS,
  isAppPageUrl,
  migrateHotkeys,
  openCookie,
  sealCookie,
  type CookieCodec,
} from '../src/shared/apiModel';
import { ClassroomApi, type StoredConfig } from '../src/main/api';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('only app://classroom pages count as the app', () => {
  assert.equal(isAppPageUrl('app://classroom/engine.html'), true);
  assert.equal(isAppPageUrl('app://classroom/panel.html?kind=chat'), true);
  for (const u of ['http://localhost:3000/login', 'https://evil.example/', 'file:///C:/x.html', 'app://other/engine.html', 'about:blank', '', null, undefined]) {
    assert.equal(isAppPageUrl(u as string), false, String(u));
  }
});

test('navigation, pop-ups, IPC and permissions are limited to the app pages', () => {
  const main = src('main/main.ts');
  assert.match(main, /app\.on\('web-contents-created'/);
  assert.match(main, /contents\.on\('will-navigate', keepInApp\)/);
  assert.match(main, /contents\.on\('will-redirect', keepInApp\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  // Every handler goes through the sender check.
  assert.doesNotMatch(main.replace(/const ipc = \{[\s\S]*?\n\};/, ''), /ipcMain\.(handle|on)\(/);
  assert.match(main, /isAppPageUrl\(from\) && \(permission === 'media'/);
  assert.match(src('preload/preload.ts'), /if \(ownPage\) contextBridge\.exposeInMainWorld/);
});

test('changing the server forgets the session cookie (it belongs to the old server)', () => {
  let saved = 0;
  const current: StoredConfig = {
    server: 'https://school.example', email: 't@x', cookie: 'classroom_teacher=abc', toolbar: null, layout: 4,
    hotkeys: { ...DEFAULT_HOTKEYS }, micId: '', camId: '',
  };
  const api = new ClassroomApi({ current, save: () => saved++ });
  assert.equal(api.setServer('https://school.example/'), 'https://school.example');
  assert.equal(current.cookie, 'classroom_teacher=abc', 'same server keeps the session');
  assert.equal(api.setServer('https://other.example'), 'https://other.example');
  assert.equal(current.cookie, null);
  assert.ok(saved >= 2);
});

test('the session cookie is stored encrypted when the OS key store is available', () => {
  const codec: CookieCodec = { available: true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().slice(4) };
  const sealed = sealCookie('classroom_teacher=abc', codec);
  assert.equal(sealed.cookie, undefined);
  assert.ok(sealed.cookieEnc);
  assert.deepEqual(openCookie(sealed, codec), { cookie: 'classroom_teacher=abc', migrate: false });
  // An old plain file is read, then flagged for re-saving encrypted.
  assert.deepEqual(openCookie({ cookie: 'classroom_teacher=old' }, codec), { cookie: 'classroom_teacher=old', migrate: true });
  // No key store (some Linux desktops): plain, as before.
  const none: CookieCodec = { ...codec, available: false };
  assert.deepEqual(sealCookie('c=1', none), { cookie: 'c=1' });
  assert.deepEqual(openCookie({ cookie: 'c=1' }, none), { cookie: 'c=1', migrate: false });
  assert.deepEqual(sealCookie(null, codec), {});
});

test('hotkeys: untouched old defaults move to the new ones, custom keys stay', () => {
  assert.deepEqual(migrateHotkeys(LEGACY_DEFAULT_HOTKEYS), { ...DEFAULT_HOTKEYS });
  assert.deepEqual(migrateHotkeys({ ...LEGACY_DEFAULT_HOTKEYS, mic: 'F9' }), { ...DEFAULT_HOTKEYS, mic: 'F9' });
  assert.deepEqual(migrateHotkeys(undefined), { ...DEFAULT_HOTKEYS });
  // None of the defaults is a common two-modifier shortcut of other apps.
  for (const v of Object.values(DEFAULT_HOTKEYS)) assert.match(v, /Alt\+Shift\+/);
});
