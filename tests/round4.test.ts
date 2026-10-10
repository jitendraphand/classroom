import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelReporter, panelShownWin, PANEL_HIDE_DEBOUNCE_MS } from '../src/shared/panelReport';
import { createEraseBatcher } from '../src/shared/web/eraseBatch';
import { SCREEN_SHARE, TEACHER_CAMERA, VIDEO_MODE_SHARE } from '../src/shared/capture';
import { SHARE_CODEC, shareProfile } from '../src/shared/web/videoQuality';
import { statePollMs, chatPollMs } from '../src/shared/web/pollPolicy';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const helper = readFileSync(new URL('../native/affinity-helper.c', import.meta.url), 'utf8');

function clock() {
  let t = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      q.push({ at: t + ms, fn, id: ++id });
      return id;
    },
    cancel: (h: unknown) => {
      const i = q.findIndex((x) => x.id === h);
      if (i >= 0) q.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (const x of q.filter((x) => x.at <= t)) {
        q.splice(q.indexOf(x), 1);
        x.fn();
      }
    },
  };
}

test('panel shown: main window when not sharing, Student videos window while sharing', () => {
  const base = { sharing: false, showStudentVideos: false, videosOpen: false, videosHidden: false, mainHidden: false };
  assert.equal(panelShownWin(base), true);
  assert.equal(panelShownWin({ ...base, mainHidden: true }), false);
  assert.equal(panelShownWin({ ...base, sharing: true }), false);
  assert.equal(panelShownWin({ ...base, sharing: true, showStudentVideos: true, videosOpen: true }), true);
  assert.equal(panelShownWin({ ...base, sharing: true, showStudentVideos: true, videosOpen: true, videosHidden: true }), false);
  assert.equal(panelShownWin({ ...base, sharing: true, showStudentVideos: true, videosOpen: false }), false);
});

test('panel reporter: shows immediately, hides debounced, no repeats', () => {
  const c = clock();
  const posts: boolean[] = [];
  const r = createPanelReporter((o) => posts.push(o), c.schedule, c.cancel);
  r.update(true);
  r.update(true);
  assert.deepEqual(posts, [true]);
  r.update(false);
  c.advance(PANEL_HIDE_DEBOUNCE_MS - 1);
  r.update(true); // quick minimize/restore: nothing
  c.advance(5000);
  assert.deepEqual(posts, [true]);
  r.update(false);
  c.advance(PANEL_HIDE_DEBOUNCE_MS);
  assert.deepEqual(posts, [true, false]);
  r.reset();
  r.update(false);
  c.advance(PANEL_HIDE_DEBOUNCE_MS);
  assert.deepEqual(posts, [true, false, false]);
});

test('class session reports the panel to /video-panel from main-process window state', () => {
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /roomApi\('POST', '\/video-panel', \{ open \}\)/);
  assert.match(cs, /onPanelWindows/);
  assert.match(cs, /this\.syncPanelReport\(\)/);
  const main = src('main/main.ts');
  assert.match(main, /webContents\.send\('panel-windows'/);
  assert.match(main, /'minimize', 'restore'/);
  assert.match(src('preload/preload.ts'), /onPanelWindows/);
});

test('eraser deletes are de-duplicated and batched (web eraseBatch, ≤50 ids per request)', () => {
  const c = clock();
  const sent: string[][] = [];
  const q = createEraseBatcher(async (body) => void sent.push(body.ids), { schedule: c.schedule });
  q.add(['a', 'b']);
  q.add(['a', 'c', 'd', 'b']);
  assert.equal(sent.length, 0);
  c.advance(200);
  assert.deepEqual(sent, [['a', 'b', 'c', 'd']]);
  q.add(Array.from({ length: 120 }, (_, i) => `x${i}`));
  c.advance(200);
  assert.deepEqual(sent.slice(1).map((x) => x.length), [50, 50, 20]);
  assert.match(src('renderer/classSession.ts'), /createEraseBatcher\(\(body\) => this\.roomApi\('POST', '\/draw', body\)\)/);
});

test('media settings match the web upgrade (673b46b)', () => {
  assert.equal(TEACHER_CAMERA.capture.height, 360);
  assert.equal(TEACHER_CAMERA.capture.frameRate, 15);
  assert.ok(TEACHER_CAMERA.encoding.maxBitrate <= 300_000);
  assert.equal(TEACHER_CAMERA.layers.length, 0);
  assert.equal(TEACHER_CAMERA.simulcast, false);
  assert.equal(SCREEN_SHARE.capture.height, 720);
  assert.ok(SCREEN_SHARE.capture.frameRate <= 8);
  assert.equal(VIDEO_MODE_SHARE.capture.frameRate, 24);
  assert.equal(VIDEO_MODE_SHARE.capture.height, 720);
  assert.equal(shareProfile(false).contentHint, 'detail');
  assert.equal(shareProfile(true).degradationPreference, 'maintain-resolution');
  assert.equal(SHARE_CODEC.codec, 'vp9');
  assert.equal(SHARE_CODEC.backupCodec, 'vp8');
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /videoCodec: SHARE_CODEC\.codec, scalabilityMode: SHARE_CODEC\.scalabilityMode, backupCodec: \{ codec: SHARE_CODEC\.backupCodec \}/);
  assert.match(cs, /degradationPreference: 'maintain-resolution'/);
  assert.match(cs, /shareOpts\(false, false\)/);
  assert.match(cs, /simulcast: TEACHER_CAMERA\.simulcast/);
  // Teacher mic as web (speech + DTX + RED); share audio music, no DTX.
  assert.match(cs, /audioPreset: AudioPresets\.speech,\s*dtx: true,\s*red: true/);
  assert.match(cs, /audioPreset: AudioPresets\.music,\s*dtx: false/);
});

test('push-driven refresh: pushLive while connected, 30 s / 60 s safety polls, coalesced /state', () => {
  assert.equal(statePollMs({ role: 'teacher', hidden: false, pushLive: true }), 30000);
  assert.equal(chatPollMs({ hidden: false, pushLive: true }), 60000);
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /get pushLive\(\): boolean \{\s*return this\.room\?\.state === ConnectionState\.Connected;/);
  assert.match(cs, /topic === STATE_TOPIC\) this\.kickState\(\)/);
  assert.match(cs, /this\.stateAgain = true/);
});

test('helper skips unchanged frames: hash + header-only heartbeat; pump and renderer handle it', () => {
  assert.match(helper, /static uint64_t frame_hash\(/);
  assert.match(helper, /static int write_same\(/);
  assert.match(helper, /keepGap = 1000/);
  assert.match(helper, /curHash != sentHash\) \{\s*dirty = 1/);
  // GPU scale stays, CPU blit fallback stays, full-monitor pool (crop fix) stays.
  assert.match(helper, /gpu_scale_blt/);
  assert.match(helper, /blit_rgba/);
  assert.match(helper, /MUST be the item's full physical size/);
  assert.match(src('main/wgcPump.ts'), /size === 0 && stride === 0[\s\S]*same: true/);
  const main = src('main/main.ts');
  assert.match(main, /function onHelperFrame/);
  assert.match(main, /rgba: Buffer\.from\(raw\.rgba\)/); // ink composited into a copy
  assert.match(main, /kickInk\(\)/);
  assert.match(src('renderer/wgcTrack.ts'), /if \(frame\.same\)/);
});
