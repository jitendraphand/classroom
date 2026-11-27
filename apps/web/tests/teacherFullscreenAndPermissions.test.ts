import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMediaIssue,
  classifyMediaError,
  createPermissionGraceTracker,
  detectPermissionBrowser,
  permissionDeniedHint,
  requestSeparatePermission,
} from '../src/lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('teachers are never forced into fullscreen (Nov 27): no auto entry, cover or prompt', () => {
  const room = read('src/components/classroom/ClassroomRoom.tsx');
  assert.doesNotMatch(room, /useTeacherFullscreen|teacher-fullscreen-cover|teacher-fullscreen-prompt|teacherFs\./);
  assert.doesNotMatch(read('src/app/teacher/dashboard/page.tsx'), /enterTeacherFullscreenOnGesture|enterFullscreen/);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'src/components/classroom/useTeacherFullscreen.ts')), false);
  // Students keep their fullscreen rules.
  assert.match(read('src/components/classroom/useStudentFocus.ts'), /export async function enterFullscreen|export function enterFullscreen/);
});

test('permission browser detection, per-browser hints, and error classification', () => {
  assert.equal(
    detectPermissionBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/126.0.0.0 Mobile Safari/537.36'),
    'chrome-android'
  );
  assert.equal(
    detectPermissionBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'),
    'ios-safari'
  );
  assert.equal(
    detectPermissionBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5),
    'ios-safari'
  );
  assert.equal(
    detectPermissionBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36'),
    'desktop-chromium'
  );
  assert.equal(
    detectPermissionBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'),
    'firefox'
  );
  assert.equal(
    detectPermissionBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'),
    'safari-mac'
  );

  assert.match(permissionDeniedHint('microphone', 'chrome-android'), /tune\/lock/i);
  assert.match(permissionDeniedHint('camera', 'ios-safari'), /Website Settings/i);
  assert.match(permissionDeniedHint('microphone', 'desktop-chromium'), /tune\/lock icon/i);
  // The device's own setting for the browser is named too (a block there shows no popup).
  assert.match(permissionDeniedHint('microphone', 'chrome-android'), /Android Settings → Apps → Chrome → Permissions/);
  assert.match(permissionDeniedHint('camera', 'desktop-chromium'), /Privacy/);
  // Chrome's "Permission dismissed": no popup on the next try either.
  assert.equal(classifyMediaError({ name: 'NotAllowedError', message: 'Permission dismissed' }, { permState: 'prompt' }), 'denied');
  // A retry straight from the tap that still fails: explain how to unblock, not "tap Allow" again.
  const afterTap = buildMediaIssue({ media: 'microphone', err: { name: 'NotAllowedError' }, permState: 'prompt', afterTap: true, ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0.0.0 Mobile Safari/537.36' });
  assert.equal(afterTap.kind, 'denied');
  assert.match(afterTap.title, /blocked/);
  assert.match(afterTap.message, /did not show the permission popup/);
  assert.doesNotMatch(afterTap.hint, /when your browser asks/);

  assert.equal(classifyMediaError({ name: 'NotAllowedError' }, { permState: 'prompt' }), 'needs-gesture');
  assert.equal(classifyMediaError({ name: 'NotAllowedError' }, { permState: 'denied' }), 'denied');
  assert.equal(classifyMediaError({ name: 'NotReadableError' }), 'in-use');
  assert.equal(classifyMediaError({ name: 'NotFoundError' }), 'not-found');
  assert.equal(classifyMediaError(new Error('nope'), { secureContext: false }), 'insecure');
  assert.equal(classifyMediaError(new Error('nope'), { hasMediaDevices: false }), 'unsupported');

  const unmutedIssue = buildMediaIssue({
    media: 'microphone',
    err: { name: 'NotAllowedError' },
    permState: 'unknown',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1',
    unmutedPrompt: true,
  });
  assert.equal(unmutedIssue.kind, 'needs-gesture');
  assert.equal(unmutedIssue.canRetry, true);
  assert.match(unmutedIssue.message, /unmuted/i);
});

test('permissionGrace tracker holds during in-flight prompt + settle grace and expires cleanly', () => {
  let now = 10_000;
  let calls = 0;
  const tracker = createPermissionGraceTracker({
    now: () => now,
    settleGraceMs: 3_000,
    maxInFlightMs: 20_000,
  });
  const unsub = tracker.subscribe(() => {
    calls += 1;
  });

  assert.equal(tracker.isActive(), false);
  const done = tracker.beginPrompt();
  assert.equal(tracker.isActive(), true);
  assert.equal(calls, 1);

  now += 5_000;
  assert.equal(tracker.isActive(), true);
  done();
  assert.equal(tracker.isActive(), true);
  assert.equal(tracker.remainingMs(), 3_000);
  assert.equal(calls, 2);

  now += 2_999;
  assert.equal(tracker.isActive(), true);
  now += 1;
  assert.equal(tracker.isActive(), false);
  assert.equal(tracker.remainingMs(), 0);

  // Max in-flight cap protects against hung prompts.
  const stuck = tracker.beginPrompt();
  now += 25_000;
  assert.equal(tracker.isActive(), false);
  stuck();
  unsub();
});

test('requestSeparatePermission requests camera and microphone independently and cleans up probe tracks', async () => {
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls: Array<{ audio?: unknown; video?: unknown }> = [];
  let stopped = 0;

  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 Chrome/126.0.0.0',
        maxTouchPoints: 0,
        mediaDevices: {
          getUserMedia: async (constraints: { audio?: unknown; video?: unknown }) => {
            calls.push(constraints);
            if (constraints.video) {
              const err = new Error('Camera denied');
              err.name = 'NotAllowedError';
              throw err;
            }
            return {
              getTracks: () => [{ stop: () => { stopped += 1; } }],
            };
          },
        },
      },
    });

    const micRes = await requestSeparatePermission('microphone');
    assert.equal(micRes.ok, true);
    assert.equal(stopped, 1);
    assert.deepEqual(calls[0], { audio: true, video: false });

    const camRes = await requestSeparatePermission('camera');
    assert.equal(camRes.ok, false);
    if (!camRes.ok) {
      assert.equal(camRes.issue.media, 'camera');
      assert.equal(camRes.issue.kind, 'denied');
    }
    assert.deepEqual(calls[1], { video: true, audio: false });
  } finally {
    if (prevDesc) Object.defineProperty(globalThis, 'navigator', prevDesc);
  }
});

test('classroom, dashboard, and waiting-room wiring invariants hold', () => {
  const room = read('src/components/classroom/ClassroomRoom.tsx');
  assert.match(room, /useScreenWakeLock\(/);
  assert.match(room, /<PermissionBanner/);
  assert.match(room, /exitFullscreenIfActive\(\)/);
  assert.match(room, /requestSeparatePermission\('microphone'\)/);
  assert.match(room, /primeVoiceAudio\(isTeacher\)/);

  const focus = read('src/components/classroom/useStudentFocus.ts');
  assert.match(focus, /permissionGrace/);
  assert.match(focus, /AWAY_SETTLE_MS/);
  assert.match(focus, /data-no-auto-fullscreen/);

  const pub = read('src/components/classroom/SelectivePublisher.tsx');
  assert.match(pub, /queryMediaPermission\('camera'\)/);
  assert.match(pub, /queryMediaPermission\('microphone'\)/);
  assert.match(pub, /withPermissionPrompt/);
  assert.match(pub, /devicechange/);
  assert.match(pub, /pageshow/);

  const joinPage = read('src/app/join/[code]/page.tsx');
  assert.match(joinPage, /<WaitingPermissionsCard \/>/);

  const adminLive = read('src/app/admin/live/[code]/page.tsx');
  assert.doesNotMatch(adminLive, /useTeacherFullscreen|useStudentFocus|enterFullscreen/);
});
