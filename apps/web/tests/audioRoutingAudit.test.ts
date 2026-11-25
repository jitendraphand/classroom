import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isMobileOs, planVoice, needsGraph, type VoiceEnv } from '../src/lib/audio/voiceSettings';
import { MIC_CAPTURE, micPublishAllowed, ownMicCurrent } from '../src/lib/audioPolicy';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8');
const desktop: VoiceEnv = { worklet: true, wasm: true, cores: 8, phone: false, mobile: false };

test('echo audit: phones and tablets keep the platform voice processing (no Web Audio graph)', () => {
  for (const s of [
    { noise: 'enhanced', focus: true },
    { noise: 'strong', focus: true },
    { noise: 'standard', focus: true },
  ] as const) {
    for (const teacher of [true, false]) {
      const plan = planVoice(s, { ...desktop, mobile: true }, teacher);
      assert.deepEqual(plan, { denoiser: null, focus: false, browserNs: true });
      assert.equal(needsGraph(plan), false);
    }
  }
  // Desktops unchanged.
  assert.equal(planVoice({ noise: 'enhanced', focus: true }, desktop, true).denoiser, 'rnnoise');
  // Mic capture keeps echo cancellation, suppression and AGC on.
  assert.deepEqual(MIC_CAPTURE, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
});

test('echo audit: mobile OS detection (Android, iPhone, iPadOS desktop UA)', () => {
  assert.equal(isMobileOs('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), true);
  assert.equal(isMobileOs('Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), true);
  assert.equal(isMobileOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isMobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 5), true);
  assert.equal(isMobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 0), false);
  assert.equal(isMobileOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 10), false);
});

test('echo audit: mic publish waits for the SFU grant', () => {
  assert.equal(micPublishAllowed(undefined), true);
  assert.equal(micPublishAllowed({ canPublish: true, canPublishSources: [] }), true);
  assert.equal(micPublishAllowed({ canPublish: true, canPublishSources: [1, 2] }), true);
  assert.equal(micPublishAllowed({ canPublish: true, canPublishSources: [1] }), false);
  assert.equal(micPublishAllowed({ canPublish: false, canPublishSources: [] }), false);
});

test('echo audit: a stale own mic track is detected', () => {
  const live = { mediaStreamTrack: { readyState: 'live' } };
  assert.equal(ownMicCurrent(live, live), true);
  assert.equal(ownMicCurrent(live, undefined), false); // SFU unpublished it
  assert.equal(ownMicCurrent(live, { other: true }), false);
  const ended = { mediaStreamTrack: { readyState: 'ended' } };
  assert.equal(ownMicCurrent(ended, ended), false);
  assert.equal(ownMicCurrent(null, null), false);
});

test('echo audit: publisher never opens an untracked mic and releases the device on mute', () => {
  const s = src('components/classroom/SelectivePublisher.tsx');
  assert.doesNotMatch(s, /setMicrophoneEnabled\(true\)/);
  assert.doesNotMatch(s, /setMicrophoneEnabled\(false\)/);
  assert.match(s, /micPublishAllowed\(participant\.permissions\)/);
  assert.match(s, /ownMicCurrent\(/);
  assert.match(s, /\[micDesired, mutedByTeacher, localParticipant, isTeacher, voiceKey, permTick\]/);
});

test('echo audit: share-audio ducking hands the mic back to the voice chain', () => {
  const s = src('components/classroom/useMicDuck.ts');
  assert.match(s, /requestVoiceRepublish\(\)/);
});

test('echo audit: classroom playback is one RoomAudioRenderer per layout, video elements muted, no audio attach', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.equal((room.match(/<RoomAudioRenderer \/>/g) ?? []).length, 2); // student layout, teacher layout
  assert.equal((room.match(/<ClassAudioUnlock \/>/g) ?? []).length, 2);
  const dir = path.join(__dirname, '../src/components/classroom');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.tsx?$/.test(f)) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /<audio[\s>]/, `${f}: audio elements only via RoomAudioRenderer`);
    assert.doesNotMatch(s, /\.attach\(/, `${f}: no manual track.attach`);
    assert.doesNotMatch(s, /webAudioMix/, `${f}: Web Audio playback defeats mobile echo cancellation`);
    assert.doesNotMatch(s, /setSinkId/, `${f}: no output switching`);
    // Every raw <video …> must be muted (they show video-only streams, but a
    // muted element can never double-play audio).
    const videos = s.match(/<video\s[^>]*>/g) ?? [];
    for (const v of videos) assert.match(v, /\bmuted\b/, `${f}: unmuted <video>`);
  }
});
