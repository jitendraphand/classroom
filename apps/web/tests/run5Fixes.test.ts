import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FLYOUT_CLOSED, flyoutReduce, hoverOpenDelay, HOVER_OPEN_MS } from '../src/lib/whiteboard/flyout';
import { ZP_IDENTITY, clampZP, isZoomed, panBy, pinchZP, toContent, zoomAt } from '../src/lib/zoomPan';
import { AudioRegistry, MIC_CAPTURE, keepShareAudio } from '../src/lib/audioPolicy';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('flyout: hover opens, leave closes unless pinned, tap toggles', () => {
  let s = flyoutReduce(FLYOUT_CLOSED, { t: 'enter', g: 'draw' });
  assert.deepEqual(s, { open: 'draw', pinned: false });
  assert.equal(hoverOpenDelay(FLYOUT_CLOSED), HOVER_OPEN_MS);
  assert.equal(hoverOpenDelay(s), 0, 'switching groups is instant');
  assert.deepEqual(flyoutReduce(s, { t: 'leave' }), FLYOUT_CLOSED);
  s = flyoutReduce(s, { t: 'tap', g: 'draw', touch: false });
  assert.deepEqual(s, { open: 'draw', pinned: true }, 'mouse click pins the hovered group');
  assert.deepEqual(flyoutReduce(s, { t: 'leave' }), s, 'pinned survives leave');
  assert.deepEqual(flyoutReduce(s, { t: 'tap', g: 'draw', touch: false }), FLYOUT_CLOSED);
  // Touch: tap opens, tap again closes, picking an option closes.
  let t = flyoutReduce(FLYOUT_CLOSED, { t: 'tap', g: 'color', touch: true });
  assert.equal(t.open, 'color');
  assert.deepEqual(flyoutReduce(t, { t: 'pick', touch: true }), FLYOUT_CLOSED);
  assert.deepEqual(flyoutReduce(t, { t: 'pick', touch: false }), t);
  t = flyoutReduce(t, { t: 'tap', g: 'color', touch: true });
  assert.deepEqual(t, FLYOUT_CLOSED);
  assert.deepEqual(flyoutReduce({ open: 'a', pinned: true }, { t: 'enter', g: 'b' }), { open: 'b', pinned: false });
});

test('zoomPan: zoom keeps the anchor point, clamps, pinch, inverse mapping', () => {
  const z = zoomAt(ZP_IDENTITY, 2, 100, 50, 400, 200);
  assert.equal(z.s, 2);
  assert.deepEqual(toContent(z, 100, 50), [100, 50], 'anchor stays under the cursor');
  assert.ok(isZoomed(z));
  const clamped = panBy(z, 10_000, 10_000, 400, 200);
  assert.deepEqual([clamped.x, clamped.y], [0, 0]);
  const far = panBy(z, -10_000, -10_000, 400, 200);
  assert.deepEqual([far.x, far.y], [-400, -200]);
  assert.deepEqual(clampZP({ s: 0.2, x: 50, y: 50 }, 400, 200), ZP_IDENTITY, 'never below 1 for viewers');
  const p = pinchZP(ZP_IDENTITY, [100, 100], [200, 100], [50, 100], [250, 100], 400, 200);
  assert.equal(p.s, 2);
  assert.equal(zoomAt(ZP_IDENTITY, 100, 0, 0, 400, 200).s, 5, 'max zoom');
  // A stroke point at the content centre maps back exactly when zoomed.
  const t = zoomAt(ZP_IDENTITY, 3, 300, 150, 400, 200);
  const [cx, cy] = toContent(t, 300, 150);
  assert.ok(Math.abs(cx - 300) < 1e-9 && Math.abs(cy - 150) < 1e-9);
});

test('audio policy: whole-screen system audio only when own output is excluded', () => {
  assert.equal(keepShareAudio('browser', {}), true);
  assert.equal(keepShareAudio('monitor', {}), false);
  assert.equal(keepShareAudio('monitor', { restrictOwnAudio: false }), false);
  assert.equal(keepShareAudio('monitor', { restrictOwnAudio: true }), true);
  assert.equal(keepShareAudio('window', null), false);
  assert.deepEqual(MIC_CAPTURE, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
});

test('audio registry: one element per remote track across mode switches and reconnects, never local', () => {
  let created = 0;
  let disposed = 0;
  const reg = new AudioRegistry<{ sid: string }>((sid) => (created++, { sid }), () => disposed++);
  assert.equal(reg.attach('mic-self', true), null, 'own mic never played');
  // normal mode: teacher mic + 2 students
  for (const sid of ['t-mic', 's1-mic', 's2-mic']) reg.attach(sid);
  // screen share starts: share audio track; duplicate TrackSubscribed events for the same sids
  for (const sid of ['t-mic', 's1-mic', 'share-audio', 'share-audio']) reg.attach(sid);
  assert.equal(reg.size, 4);
  // whiteboard mode: share audio unpublished
  reg.detach('share-audio');
  assert.equal(reg.size, 3);
  // reconnect: SDK re-subscribes everything (new events), stale ones pruned
  for (const sid of ['t-mic', 's1-mic']) reg.attach(sid);
  reg.prune(['t-mic', 's1-mic']);
  assert.equal(reg.size, 2);
  assert.equal(created, 4);
  assert.equal(disposed, 2);
  reg.clear();
  assert.equal(reg.size, 0);
});

test('web teacher mic uses explicit echo cancellation / NS / AGC; share audio goes through the echo guard', () => {
  const room = classroomViewSource();
  // The mic comes from the noise-removal chain, which always keeps the
  // browser's echo cancellation and AGC, and its noise suppression whenever
  // no AI noise remover runs (including every fallback).
  assert.match(room, /createVoiceTrack\(isTeacher\)/);
  const voice = src('lib/audio/voiceProcessor.ts');
  assert.match(voice, /createLocalAudioTrack\(\{ \.\.\.MIC_CAPTURE, \.\.\.pick \}\)/);
  assert.match(voice, /createLocalAudioTrack\(\{ \.\.\.MIC_CAPTURE, noiseSuppression: plan\.browserNs, \.\.\.pick \}\)/);
  assert.match(voice, /restartTrack\(\{ \.\.\.MIC_CAPTURE, \.\.\.pick \}\)/);
  assert.match(room, /keepShareAudio\(audioSurface/);
  // RoomAudioRenderer exactly once per path (student, teacher): no duplicate playback.
  assert.equal((room.match(/<RoomAudioRenderer \/>/g) ?? []).length, 2);
  const admin = src('components/admin/OngoingClasses.tsx');
  assert.doesNotMatch(admin, /RoomAudioRenderer/, 'admin previews never play audio');
});

test('whiteboard mode: meeting bar stops the board; roster chips can allow and deny drawing', () => {
  const room = classroomViewSource();
  assert.match(room, /WhiteboardMeetingBar/);
  assert.match(room, /onStopWhiteboard=/);
  assert.match(room, /isTeacher && screenOn && !wbOpen/);
  assert.match(room, /!wbOpen && \(/);
  const bar = src('components/classroom/MeetingBar.tsx');
  assert.match(bar, /aria-label="Stop whiteboard sharing"/);
  assert.match(bar, /aria-label="End class"/);
  assert.match(bar, /wbm-draw-allow/);
  assert.match(bar, /wbm-draw-deny/);
  const hud = src('components/classroom/TeacherShareHud.tsx');
  assert.match(hud, /hud-draw-allow/);
  assert.match(hud, /hud-draw-deny/);
  const wbRoute = src('app/api/rooms/[code]/whiteboard/route.ts');
  assert.match(wbRoute, /endDrawingSession/);
});

test('waiting room Leave leaves (no reload into the same page) and shows Rejoin', () => {
  const page = src('app/join/[code]/page.tsx');
  assert.match(page, /\/leave`/);
  assert.match(page, /You left the class/);
  assert.match(page, /data-testid="rejoin"/);
  assert.doesNotMatch(page, />\s*Leave\s*<\/Link>/);
});

test('fullscreen cover keeps the whiteboard mounted underneath', () => {
  const room = classroomViewSource();
  assert.match(room, /\{state\?\.whiteboard && !teacherGone \? \(/);
  assert.match(room, /\) : covered \? null : showTeacherScreen \? \(/);
});
