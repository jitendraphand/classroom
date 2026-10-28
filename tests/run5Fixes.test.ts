import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flyoutBounds } from '../src/shared/toolbarLayout';
import { SHARE_AUDIO_ECHO_WARNING, wantShareAudio } from '../src/shared/shareAudio';
import { sidecarInit } from '../src/shared/sidecar';
import { AudioRegistry } from '../src/shared/web/audioPolicy';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const area = { x: 0, y: 0, width: 1920, height: 1040 };

test('item 1-2: home bar starts whiteboard sharing; Board removed from the share toolbar; no videos button', () => {
  const engine = src('renderer/engine.ts');
  assert.match(engine, /sym\('btn-board', 'board', 'Share a whiteboard \(students see it live\)', '', 'Whiteboard'\)/);
  assert.match(engine, /btn-board'\)\?\.addEventListener\('click', act\('toggle-whiteboard'\)\)/);
  assert.doesNotMatch(engine, /btn-videos|btn-pen/);
  assert.doesNotMatch(src('renderer/toolbar.tsx'), /toggle-whiteboard/);
});

test('item 3: grouped share toolbar; flyout grows the window without moving the bar', () => {
  const tools = src('renderer/tools.tsx');
  for (const id of ['atb-g-draw', 'atb-g-erase', 'atb-g-color', 'atb-g-meeting', 'atb-g-share', 'atb-g-perm']) assert.ok(tools.includes(id), id);
  const bar = { x: 400, y: 100, width: 520, height: 54 };
  const below = flyoutBounds('horizontal', bar, 60, 300, area);
  assert.equal(below.side, 'after');
  assert.deepEqual(below.rect, { x: 400, y: 100, width: 520, height: 114 });
  const nearBottom = flyoutBounds('horizontal', { ...bar, y: 1000 - 54 + 30 }, 60, 300, area);
  assert.equal(nearBottom.side, 'before');
  assert.equal(nearBottom.rect.y + 60, 976, 'bar keeps its y');
  const v = { x: 1860, y: 200, width: 54, height: 520 };
  const left = flyoutBounds('vertical', v, 200, 300, area);
  assert.equal(left.side, 'before');
  assert.equal(left.rect.x + 200, 1860, 'vertical bar keeps its x');
  assert.deepEqual(flyoutBounds('vertical', v, 0, 0, area).rect, v);
  assert.match(src('main/main.ts'), /ipc\.on\('annotate-tools-flyout'/);
});

test('item 4-5: whiteboard window has a right meeting bar with draw allow/deny; roster Allow works in whiteboard mode', () => {
  const wb = src('renderer/whiteboard.tsx');
  for (const id of ['wbm-mic', 'wbm-cam', 'wbm-chat', 'wbm-people', 'wbm-admit', 'wbm-draw-allow', 'wbm-draw-deny', 'wbm-mute-all', 'wbm-stop', 'wbm-end']) assert.ok(wb.includes(id), id);
  assert.match(wb, /hideStop=\{!!meeting\}/);
  const views = src('renderer/teacherViews.tsx');
  assert.match(views, /const sharing = snap\.hud\.sharing \|\| !!snap\.hud\.whiteboardOn;/);
  assert.match(views, /data-testid="draw-deny"/);
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /return this\.sharing \|\| !!this\.whiteboard;/, 'videos float during the whiteboard');
  assert.match(src('main/main.ts'), /name === 'classroom-whiteboard' && !child\.isDestroyed\(\)\) child\.maximize\(\)/);
  assert.match(src('renderer/videos.tsx'), /videos-min/);
});

test('item 7: share audio never includes the app\'s own output by default', () => {
  // Electron fallback (whole-device loopback): auto never sends.
  assert.equal(wantShareAudio({ choice: 'auto', videoMode: true, askedAtStart: false, excludesOwnOutput: false }), false);
  // Sidecar process loopback that excludes the app: follows Video mode.
  assert.equal(wantShareAudio({ choice: 'auto', videoMode: true, askedAtStart: false, excludesOwnOutput: true }), true);
  assert.equal(wantShareAudio({ choice: 'on', videoMode: false, askedAtStart: false, excludesOwnOutput: false }), true, 'explicit choice is respected (with a warning)');
  assert.match(SHARE_AUDIO_ECHO_WARNING, /headphones/);
  const init = sidecarInit({ url: 'wss://x.example', token: 'x'.repeat(40), audio: true }, { slidesFps: 8, videoFps: 30, maxBitrate: 1, videoBitrate: 1, excludePid: 4242 });
  assert.equal(init?.excludePid, 4242);
  assert.equal(sidecarInit({ url: 'wss://x.example', token: 'x'.repeat(40) }, { slidesFps: 8, videoFps: 30, maxBitrate: 1, videoBitrate: 1 })?.excludePid, 0);
  assert.match(src('main/main.ts'), /excludePid: process\.pid/);
  const rs = fs.readFileSync(path.join(__dirname, '..', 'native/share-sidecar/src/main.rs'), 'utf8');
  assert.match(rs, /new_application_loopback_client\(exclude_pid, false\)/);
  assert.doesNotMatch(rs, /get_default_device\(&Direction::Render\)/, 'no whole-device loopback');
});

test('item 7: one audio element per remote track across share / whiteboard / reconnect; mic keeps AEC/NS/AGC', () => {
  const cs = src('renderer/classSession.ts');
  assert.doesNotMatch(cs, /const el = track\.attach\(\);\s*document\.getElementById\('audio'\)/);
  assert.match(cs, /this\.audioEls\.attach\(/);
  assert.match(cs, /this\.audioEls\.detach\(/);
  assert.match(cs, /this\.audioEls\.clear\(\)/);
  // The web voice chain: AEC and AGC always, the browser's NS whenever no AI
  // noise remover runs (and in every fallback).
  assert.match(cs, /createVoiceTrack\(true/);
  const voice = src('shared/web/audio/voiceProcessor.ts');
  assert.match(voice, /createLocalAudioTrack\(\{ \.\.\.MIC_CAPTURE, \.\.\.pick \}\)/);
  assert.match(voice, /restartTrack\(\{ \.\.\.MIC_CAPTURE, \.\.\.pick \}\)/);
  // Simulated session: per participant count stays 1 per published audio track.
  const dom: string[] = [];
  const reg = new AudioRegistry<string>((sid) => (dom.push(sid), sid), (sid) => dom.splice(dom.indexOf(sid), 1));
  const subscribe = (sids: string[]) => sids.forEach((s) => reg.attach(s));
  subscribe(['s1', 's2', 's3']); // normal
  subscribe(['s1', 's2', 's3']); // screen share (duplicate events)
  subscribe(['s1', 's2', 's3']); // whiteboard
  reg.prune(['s1', 's3']); // reconnect, s2 left
  subscribe(['s1', 's3', 's2b']); // s2 rejoined with a new track
  assert.deepEqual([...dom].sort(), ['s1', 's2b', 's3']);
  assert.equal(reg.attach('mine', true), null);
});
