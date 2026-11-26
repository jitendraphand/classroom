/**
 * Web video improvements (2026-11-26): spotlight follows data saving, camera
 * standby, slide snapshots for "Audio only", cheaper student tiles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spotlightCameraWanted } from '../src/lib/dataSaver';
import { CAMERA_STANDBY_GRACE_MS, cameraDeviceNeeded, cameraReportedOn } from '../src/lib/cameraStandby';
import {
  MIN_UPLOAD_GAP_MS,
  SNAPSHOT_MAX_BYTES,
  decodeSnapshotPacket,
  shouldUpload,
  snapshotBytesValid,
  snapshotSize,
  thumbnailChanged,
} from '../src/lib/slideSnapshot';
import { STUDENT_CAMERA } from '../src/lib/videoQuality';

const src = (p: string) => readFileSync(`src/${p}`, 'utf8');

// ---------------------------------------------------------------- spotlight

test('the spotlighted classmate camera follows data saving like the teacher camera', () => {
  assert.equal(spotlightCameraWanted({ mode: 'off' }), true);
  assert.equal(spotlightCameraWanted({ mode: 'low' }), true);
  assert.equal(spotlightCameraWanted({ mode: 'share-only' }), false);
  assert.equal(spotlightCameraWanted({ mode: 'audio-only' }), false);
  assert.equal(spotlightCameraWanted({ mode: 'off', backgroundPaused: true }), false);
  const privacy = src('components/classroom/StudentMediaPrivacy.tsx');
  assert.match(privacy, /spotlightCamWanted && !!spotlightIdentity && p\.identity === spotlightIdentity/);
  const float = src('components/classroom/SpotlightFloat.tsx');
  assert.match(float, /if \(hidden \|\| videoOff\)/);
  assert.match(float, /Video off to save data/);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /spotlightCamWanted=\{spotlightVideoOn\}/);
  assert.match(room, /videoOff=\{!spotlightVideoOn\}/);
});

// ---------------------------------------------------------------- camera standby

test('the camera device is needed only when the server wants the video or the self-view shows', () => {
  assert.equal(cameraDeviceNeeded({ camOn: false, serverWantsVideo: true, selfPreviewShown: true }), false);
  assert.equal(cameraDeviceNeeded({ camOn: true, serverWantsVideo: false, selfPreviewShown: false }), false);
  assert.equal(cameraDeviceNeeded({ camOn: true, serverWantsVideo: true, selfPreviewShown: false }), true);
  assert.equal(cameraDeviceNeeded({ camOn: true, serverWantsVideo: false, selfPreviewShown: true }), true);
  assert.equal(CAMERA_STANDBY_GRACE_MS, 10_000);
});

test('a camera in standby still counts as on (pages, unmute), but only once it has worked', () => {
  assert.equal(cameraReportedOn({ camOn: true, live: true, standby: false, workedBefore: true }), true);
  assert.equal(cameraReportedOn({ camOn: true, live: false, standby: true, workedBefore: true }), true);
  assert.equal(cameraReportedOn({ camOn: true, live: false, standby: true, workedBefore: false }), false);
  assert.equal(cameraReportedOn({ camOn: true, live: false, standby: false, workedBefore: true }), false); // failed / reopening
  assert.equal(cameraReportedOn({ camOn: false, live: false, standby: true, workedBefore: true }), false);
});

test('standby is wired: the publisher releases the device, the room reports standby as on', () => {
  const pub = src('components/classroom/SelectivePublisher.tsx');
  assert.match(pub, /if \(!camDesired \|\| !camDeviceNeeded\) \{/);
  assert.match(pub, /\}, \[camDesired, camDeviceNeeded, camRetryTick, camRecoveryTick\]\);/);
  assert.match(pub, /camDesiredRef\.current && camNeededRef\.current/); // no recovery reopen in standby
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /useTrueWithGrace\(camNeededNow, CAMERA_STANDBY_GRACE_MS\)/);
  assert.match(room, /camDeviceNeeded=\{camDeviceNeeded\}/);
  assert.match(room, /cameraReportedOn\(\{ camOn, live: camStreamLive, standby: !camDeviceNeeded, workedBefore: camWorkedRef\.current \}\)/);
  // A camera that never opened is opened once to confirm it works.
  assert.match(room, /\(camOn && !camWorkedRef\.current\)/);
});

// ---------------------------------------------------------------- cheaper tiles

test('student camera is tile-sized: 12 fps, ≤120 kbps', () => {
  assert.equal(STUDENT_CAMERA.encoding.maxFramerate, 12);
  assert.ok(STUDENT_CAMERA.encoding.maxBitrate <= 120_000);
});

// ---------------------------------------------------------------- slide snapshots

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const webp = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)), new Array(12).fill(0)));

test('snapshot bytes must really be the declared image type and size', () => {
  assert.equal(snapshotBytesValid(jpeg, 'image/jpeg'), true);
  assert.equal(snapshotBytesValid(webp, 'image/webp'), true);
  assert.equal(snapshotBytesValid(jpeg, 'image/webp'), false);
  assert.equal(snapshotBytesValid(webp, 'image/jpeg'), false);
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  assert.equal(snapshotBytesValid(html, 'image/jpeg'), false);
  assert.equal(snapshotBytesValid(new Uint8Array(SNAPSHOT_MAX_BYTES + 1).fill(0xff), 'image/jpeg'), false);
});

test('snapshot sizing keeps the aspect ratio, never upscales', () => {
  assert.deepEqual(snapshotSize(1920, 1080), { w: 1280, h: 720 });
  assert.deepEqual(snapshotSize(1080, 1920), { w: 720, h: 1280 });
  assert.deepEqual(snapshotSize(800, 600), { w: 800, h: 600 });
  assert.deepEqual(snapshotSize(0, 600), { w: 0, h: 0 });
});

test('change detection: pointer-sized changes are ignored, a new slide is sent, slow edits add up', () => {
  const blank = new Uint8Array(64 * 36).fill(255);
  assert.equal(thumbnailChanged(null, blank), true); // first picture
  assert.equal(thumbnailChanged(blank, blank), false);
  const pointer = blank.slice();
  pointer[100] = 0; // one thumbnail pixel (≈ a pointer)
  assert.equal(thumbnailChanged(blank, pointer), false);
  const newSlide = blank.map((v, i) => (i % 3 ? v : 0));
  assert.equal(thumbnailChanged(blank, newSlide), true);
  // Writing on a slide: each check differs little from the last, but the
  // hook compares with the last picture SENT, so it accumulates.
  const cur = blank.slice();
  for (let i = 0; i < 40; i++) cur[i] = 0;
  assert.equal(thumbnailChanged(blank, cur), true);
  const hook = src('components/classroom/useShareSnapshots.ts');
  assert.match(hook, /thumbnailChanged\(sentThumb, gray\)/);
  assert.match(hook, /sentThumb = gray;/);
});

test('uploads are spaced at least MIN_UPLOAD_GAP_MS; a change in the gap is sent after it', () => {
  assert.equal(shouldUpload({ changed: true, now: 0, lastUploadAt: -MIN_UPLOAD_GAP_MS, pendingChange: false }), true);
  assert.equal(shouldUpload({ changed: true, now: 5_000, lastUploadAt: 0, pendingChange: false }), false);
  assert.equal(shouldUpload({ changed: false, now: 12_000, lastUploadAt: 0, pendingChange: true }), true);
  assert.equal(shouldUpload({ changed: false, now: 60_000, lastUploadAt: 0, pendingChange: false }), false);
});

test('snapshot push packets are validated; 0 means cleared', () => {
  assert.deepEqual(decodeSnapshotPacket({ v: 1, ver: 123 }), { v: 1, ver: 123 });
  assert.deepEqual(decodeSnapshotPacket({ v: 1, ver: 0 }), { v: 1, ver: 0 });
  assert.equal(decodeSnapshotPacket({ v: 2, ver: 1 }), null);
  assert.equal(decodeSnapshotPacket({ v: 1, ver: 'x' }), null);
  assert.equal(decodeSnapshotPacket(null), null);
});

test('snapshot route: teacher uploads, only admitted students / the teacher read, conditional GET', () => {
  const route = src('app/api/rooms/[code]/snapshot/route.ts');
  assert.match(route, /room\.teacherId !== teacher\.id/);
  assert.match(route, /snapshotBytesValid\(bytes, parsed\.data\.type\)/);
  assert.match(route, /overRateLimit\(`ratelimit:snapshot:\$\{code\}`/);
  assert.match(route, /access\.student\.status === 'ADMITTED'/);
  assert.match(route, /if-none-match/);
  assert.match(route, /status: 304/);
  assert.match(route, /'X-Content-Type-Options': 'nosniff'/);
  const stage = src('components/classroom/SlideSnapshotStage.tsx');
  assert.match(stage, /senderKind\(participant\?\.identity\) !== 'server'/); // only server pushes
  assert.match(stage, /SNAPSHOT_FETCH_SPREAD_MS/);
  assert.match(stage, /'If-None-Match'/);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /useShareSnapshots\(\{ room, code, active: isTeacher && screenOn \}\)/);
  assert.match(room, /dataSaver === 'audio-only' \? \(\s*<SlideSnapshotStage code=\{code\} \/>/);
  // Snapshot keys are cleared with the room.
  assert.match(src('lib/teacherRoom.ts'), /keys\.snapshot\(code\),\s*keys\.snapshotMeta\(code\)/);
});
