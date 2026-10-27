import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackSource, TrackType } from 'livekit-server-sdk';
import { effectiveStudentSources, permissionPushConcurrency, runBounded, tracksToMute } from '../src/lib/livekit';
import { isPresenceTeacher, presenceActionFor, teacherPresentAmong } from '../src/lib/teacherPresenceLogic';

test('effective student sources: teacher absence locks the mic, spotlight keeps the camera', () => {
  const ctx = { teacherPresent: true, spotlightIdentity: 'student_s' };
  assert.deepEqual(effectiveStudentSources({ identity: 'student_a', allowCamera: false, allowMic: true }, ctx).sources, [TrackSource.MICROPHONE]);
  assert.deepEqual(effectiveStudentSources({ identity: 'student_s', allowCamera: false, allowMic: false }, ctx).sources, [TrackSource.CAMERA]);
  const away = effectiveStudentSources({ identity: 'student_a', allowCamera: true, allowMic: true }, { ...ctx, teacherPresent: false });
  assert.equal(away.allowMic, false);
  assert.deepEqual(away.sources, [TrackSource.CAMERA]);
});

test('tracksToMute uses the updateParticipant result (no room listing) and skips muted tracks', () => {
  const tracks = [
    { sid: 'TR_cam', type: TrackType.VIDEO, source: TrackSource.CAMERA },
    { sid: 'TR_mic', type: TrackType.AUDIO, source: TrackSource.MICROPHONE },
    { sid: 'TR_old', type: TrackType.AUDIO, source: TrackSource.UNKNOWN },
    { sid: 'TR_shareaudio', type: TrackType.AUDIO, source: TrackSource.SCREEN_SHARE_AUDIO },
    { sid: 'TR_done', type: TrackType.VIDEO, source: TrackSource.CAMERA, muted: true },
  ];
  assert.deepEqual(tracksToMute(tracks, { allowCamera: false, allowMic: false }), ['TR_cam', 'TR_mic', 'TR_old']);
  assert.deepEqual(tracksToMute(tracks, { allowCamera: true, allowMic: false }), ['TR_mic', 'TR_old']);
  assert.deepEqual(tracksToMute(undefined, { allowCamera: false, allowMic: false }), []);
});

test('runBounded never exceeds its concurrency and survives failures', async () => {
  let inFlight = 0;
  let peak = 0;
  const done: number[] = [];
  await runBounded(Array.from({ length: 50 }, (_, i) => i), 4, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    if (i === 7) throw new Error('boom');
    done.push(i);
  });
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(done.length, 49);
  assert.equal(permissionPushConcurrency({}), 8);
  assert.equal(permissionPushConcurrency({ PERMISSION_PUSH_CONCURRENCY: '500' }), 64);
});

test('the Windows screen-share sidecar is not teacher presence', () => {
  const ROOM = 'classroom_ABC123_s1';
  assert.equal(isPresenceTeacher('teacher_t1_ABC123'), true);
  assert.equal(isPresenceTeacher('teacher_t1_ABC123__screen'), false);
  assert.equal(teacherPresentAmong([{ identity: 'teacher_t1_ABC123__screen', sid: 'PA_s' }]), false);
  const sidecar = { identity: 'teacher_t1_ABC123__screen', sid: 'PA_s' };
  assert.equal(presenceActionFor({ event: 'participant_joined', room: { name: ROOM }, participant: sidecar }).kind, 'ignore');
  assert.equal(presenceActionFor({ event: 'participant_left', room: { name: ROOM }, participant: sidecar }).kind, 'ignore');
});
