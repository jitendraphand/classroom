/**
 * Fixes from the 2026-11-26 audit (audit-reports/FINDINGS_REGISTER.md).
 * Pure helpers are tested directly; wiring is checked in the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BACKGROUND_VIDEO_PAUSE_MS,
  dataSaverBadge,
  dataSaverLabel,
  initialDataSaver,
  teacherCameraOff,
  teacherVideoDemand,
} from '../src/lib/dataSaver';
import { setVideoWanted } from '../src/lib/videoEnable';
import { bodyLimitFor, bodyTooLarge, DEFAULT_BODY_LIMIT, LARGE_BODY_LIMIT } from '../src/lib/bodyLimit';
import { STUDENT_ACTION_LIMITS, studentActionKey } from '../src/lib/rateLimit';
import {
  nameJoinAllowedFromEnv,
  newNameJoinKey,
  newNameJoinsPerClassFromEnv,
  unauthenticatedJoinWarning,
} from '../src/lib/schoolJoin';
import { chatRetentionHours } from '../src/lib/retention';
import { WB_SNAP_MAX_B64, WB_SNAP_MAX_PACKETS } from '../src/lib/whiteboardServer';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const repo = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------- DATA-01 / DATA-02

test('audio only turns off the teacher camera and the screen share', () => {
  const d = teacherVideoDemand({ mode: 'audio-only', camPaneMinimized: false });
  assert.equal(d.cameraEnabled, false);
  assert.equal(d.shareEnabled, false);
  assert.equal(teacherCameraOff('audio-only'), true);
  assert.equal(teacherCameraOff('share-only'), true);
  assert.equal(teacherCameraOff('low'), false);
  assert.equal(dataSaverBadge('audio-only'), 'Audio');
  assert.equal(dataSaverBadge('share-only'), 'Share');
  assert.match(dataSaverLabel('audio-only'), /Audio only/);
});

test('a page hidden for 20 s receives no teacher video, whatever the mode', () => {
  assert.equal(BACKGROUND_VIDEO_PAUSE_MS, 20_000);
  for (const mode of ['off', 'low', 'share-only', 'audio-only'] as const) {
    const d = teacherVideoDemand({ mode, camPaneMinimized: false, backgroundPaused: true });
    assert.equal(d.cameraEnabled, false, mode);
    assert.equal(d.shareEnabled, false, mode);
  }
  // Visible again: back to the mode's normal demand.
  assert.equal(teacherVideoDemand({ mode: 'off', camPaneMinimized: false, backgroundPaused: false }).shareEnabled, true);
});

test('starting mode follows Save-Data and the link type, never above the media profile', () => {
  assert.equal(initialDataSaver('standard', undefined), 'off');
  assert.equal(initialDataSaver('standard', null), 'off');
  assert.equal(initialDataSaver('standard', { effectiveType: '4g' }), 'off');
  assert.equal(initialDataSaver('standard', { effectiveType: '3g' }), 'low');
  assert.equal(initialDataSaver('standard', { effectiveType: '2g' }), 'audio-only');
  assert.equal(initialDataSaver('standard', { effectiveType: 'slow-2g' }), 'audio-only');
  assert.equal(initialDataSaver('standard', { saveData: true, effectiveType: '4g' }), 'audio-only');
  assert.equal(initialDataSaver('low', undefined), 'low');
  assert.equal(initialDataSaver('low', { effectiveType: '2g' }), 'audio-only');
});

/** Minimal stand-in for livekit-client 2.22's RemoteTrackPublication enable logic. */
class FakePub {
  requestedDisabled: boolean | undefined = undefined;
  visible = true;
  updates = 0;
  get isEnabled() {
    return this.requestedDisabled !== undefined ? !this.requestedDisabled : this.visible;
  }
  setEnabled(enabled: boolean) {
    if (this.requestedDisabled === !enabled) return;
    this.requestedDisabled = !enabled;
    this.emitTrackUpdate();
  }
  emitTrackUpdate() {
    this.updates++;
  }
}

test('setVideoWanted disables, then hands control back to adaptiveStream', () => {
  const pub = new FakePub();
  setVideoWanted(pub, true); // never disabled: nothing to do
  assert.equal(pub.updates, 0);
  assert.equal(pub.requestedDisabled, undefined);

  setVideoWanted(pub, false);
  assert.equal(pub.isEnabled, false);
  assert.equal(pub.updates, 1);

  setVideoWanted(pub, true);
  assert.equal(pub.requestedDisabled, undefined, 'not forced on: adaptiveStream decides again');
  assert.equal(pub.updates, 2);
  // An element that is not shown (share under the whiteboard) stays off.
  pub.visible = false;
  assert.equal(pub.isEnabled, false);
});

test('setVideoWanted falls back to the public API if SDK internals change', () => {
  let enabled = false;
  const pub = {
    get isEnabled() {
      return enabled;
    },
    setEnabled(v: boolean) {
      enabled = v;
    },
  };
  setVideoWanted(pub, true);
  assert.equal(enabled, true);
  setVideoWanted(pub, false);
  assert.equal(enabled, false);
});

test('the student video demand covers the share (incl. the Windows sidecar) and the hidden page', () => {
  const demand = src('components/classroom/TeacherMediaDemand.tsx');
  assert.match(demand, /useHiddenFor\(BACKGROUND_VIDEO_PAUSE_MS\)/);
  assert.match(demand, /teacherVideoDemand\(\{ mode, camPaneMinimized, backgroundPaused \}\)/);
  assert.match(demand, /setVideoWanted\(pub, want\.shareEnabled\)/);
  assert.match(demand, /endsWith\('__screen'\)/);
  // Audio is never touched by the data saver.
  assert.doesNotMatch(demand, /Track\.Source\.Microphone/);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /<SlideSnapshotStage code=\{code\} \/>/);
  assert.match(src('components/classroom/SlideSnapshotStage.tsx'), /data-testid="audio-only-stage"/);
  const hook = src('hooks/useDataSaver.ts');
  assert.match(hook, /initialDataSaver\(mediaProfile\(\), conn\)/);
});

// ---------------------------------------------------------------- SEC-05

test('request bodies are capped per route before parsing', () => {
  assert.equal(bodyLimitFor('/api/rooms/ABC123/messages'), DEFAULT_BODY_LIMIT);
  assert.equal(bodyLimitFor('/api/join-class'), DEFAULT_BODY_LIMIT);
  assert.equal(bodyLimitFor('/api/rooms/ABC123/whiteboard'), LARGE_BODY_LIMIT);
  assert.equal(bodyLimitFor('/api/admin/live/ABC123/whiteboard'), LARGE_BODY_LIMIT);
  assert.equal(bodyLimitFor('/api/admin/students/import'), LARGE_BODY_LIMIT);
  // The largest whiteboard snapshot the server accepts fits under the large cap.
  assert.ok(WB_SNAP_MAX_PACKETS * (WB_SNAP_MAX_B64 + 4) < LARGE_BODY_LIMIT);
  // The roster CSV (≤ 2,000,000 chars, up to 3 bytes each as UTF-8 JSON) fits too.
  assert.ok(2_000_000 * 3 < LARGE_BODY_LIMIT);

  assert.equal(bodyTooLarge('/api/join-class', String(DEFAULT_BODY_LIMIT)), false);
  assert.equal(bodyTooLarge('/api/join-class', String(DEFAULT_BODY_LIMIT + 1)), true);
  assert.equal(bodyTooLarge('/api/rooms/A/whiteboard', String(DEFAULT_BODY_LIMIT + 1)), false);
  assert.equal(bodyTooLarge('/api/rooms/A/whiteboard', String(LARGE_BODY_LIMIT + 1)), true);
  assert.equal(bodyTooLarge('/api/join-class', null), false);
  assert.equal(bodyTooLarge('/api/join-class', ''), false);
  assert.equal(bodyTooLarge('/api/join-class', 'abc'), false);

  const mw = src('middleware.ts');
  assert.match(mw, /bodyTooLarge\(pathname, req\.headers\.get\('content-length'\)\)/);
  assert.match(mw, /status: 413/);
  for (const f of ['infra/Caddyfile', 'scripts/configure-domain-tls.sh']) {
    assert.match(repo(f), /request_body \{\s*max_size 8MB\s*\}/, f);
  }
});

// ---------------------------------------------------------------- SEC-04

test('students cannot flood the teacher with hand or draw-request toggles', () => {
  assert.equal(STUDENT_ACTION_LIMITS.hand.limit, 30);
  assert.equal(STUDENT_ACTION_LIMITS.drawRequest.limit, 20);
  assert.equal(studentActionKey('hand', 'p1'), 'ratelimit:student:hand:p1');
  assert.match(src('app/api/rooms/[code]/hand/route.ts'), /studentActionLimited\('hand', me\.id\)[\s\S]*429/);
  const draw = src('app/api/rooms/[code]/draw/route.ts');
  assert.match(draw, /studentActionLimited\('drawRequest', me\.id\)[\s\S]*429/);
  // Stroke points are not limited (one approved drawer).
  assert.doesNotMatch(draw, /studentActionLimited\('pts'/);
});

// ---------------------------------------------------------------- SEC-02 / SEC-03

test('name join can be switched off; unauthenticated joining is warned about in production', () => {
  assert.equal(nameJoinAllowedFromEnv({}), true);
  assert.equal(nameJoinAllowedFromEnv({ ALLOW_NAME_JOIN: 'true' }), true);
  for (const v of ['false', '0', 'no', 'off', ' FALSE ']) assert.equal(nameJoinAllowedFromEnv({ ALLOW_NAME_JOIN: v }), false, v);

  assert.equal(unauthenticatedJoinWarning({ NODE_ENV: 'development' }), null);
  assert.match(unauthenticatedJoinWarning({ NODE_ENV: 'production' }) ?? '', /unsigned[\s\S]*Join the class/);
  assert.match(
    unauthenticatedJoinWarning({ NODE_ENV: 'production', SCHOOL_JOIN_MODE: 'signed' }) ?? '',
    /ALLOW_NAME_JOIN/,
  );
  assert.equal(unauthenticatedJoinWarning({ NODE_ENV: 'production', SCHOOL_JOIN_MODE: 'signed', ALLOW_NAME_JOIN: 'false' }), null);
  assert.match(src('instrumentation.ts'), /unauthenticatedJoinWarning\(\)/);
});

test('new names per class per day are capped; the key is per class, not per IP', () => {
  assert.equal(newNameJoinsPerClassFromEnv({}), 150);
  assert.equal(newNameJoinsPerClassFromEnv({ NEW_NAME_JOINS_PER_CLASS_PER_DAY: '0' }), 0);
  assert.equal(newNameJoinsPerClassFromEnv({ NEW_NAME_JOINS_PER_CLASS_PER_DAY: '40' }), 40);
  assert.equal(
    newNameJoinKey({ campus: 'AIRPORTCAMPUS', grade: '7', division: 'SCIENCEFOUNDATION' }),
    'ratelimit:join:newname:airportcampus|7|sciencefoundation',
  );
  const api = src('app/api/join-class/route.ts');
  assert.match(api, /claims\.studentId\.startsWith\('WEB-'\)/);
  assert.match(api, /JoinTokenError\('rate_limited'/);
  assert.match(api, /ensureJoinAudienceCached\(\)/);
});

// ---------------------------------------------------------------- SEC-07 / PERF-08 / INF-01

test('chat of ended classes is purged; the retention sweep has an index', () => {
  assert.equal(chatRetentionHours({}), 24);
  assert.equal(chatRetentionHours({ CHAT_RETENTION_HOURS: '0' }), 0);
  assert.equal(chatRetentionHours({ CHAT_RETENTION_HOURS: '72' }), 72);
  const ret = src('lib/retention.ts');
  assert.match(ret, /room: \{ status: 'ENDED' \}/);
  assert.match(ret, /await pruneEndedChat\(\)/);
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /@@index\(\[status, leftAt\]\)/);
});

test('backup script dumps, validates, rotates and can copy off the box', () => {
  const s = repo('scripts/backup-db.sh');
  assert.match(s, /pg_dump -U "\$pg_user" -d "\$pg_db" -Fc/);
  assert.match(s, /PGDMP/); // refuses an empty or broken dump
  assert.match(s, /BACKUP_COPY_CMD/);
  assert.match(s, /--restore/);
  assert.match(repo('.gitignore'), /^backups\/$/m);
});

// ---------------------------------------------------------------- SEC-01

test('Next.js is past the image-optimizer advisories and the optimizer is off', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  const [maj, min, patch] = pkg.dependencies.next.replace(/^[^\d]*/, '').split('.').map(Number);
  assert.ok(maj > 15 || (maj === 15 && (min > 5 || (min === 5 && patch >= 29))), pkg.dependencies.next);
  const cfg = readFileSync(new URL('../next.config.mjs', import.meta.url), 'utf8');
  assert.match(cfg, /images: \{ unoptimized: true \}/);
});
