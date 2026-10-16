/** Regression tests for the Windows E2E findings of 2026-10-09. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCaptureSupervisor, monitorArgs, pickDisplay, type CaptureStatus } from '../src/main/captureSupervisor';
import { createWgcPump } from '../src/main/wgcPump';
import { compositeInkLayer, cropInk, layerAlreadyInFrame, parseInkLayer } from '../src/shared/inkLayer';
import { desktopLoopbackConstraints, toggleShareAudio, wantShareAudio } from '../src/shared/shareAudio';
import { fillStudentSlots, visibleCells } from '../src/shared/classLogic';

function solid(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return a;
}

// ---- (1) Stale capture recovery ----

function fakeTimers() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        for (let i = 0; i < 30; i++) await Promise.resolve();
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
        for (let i = 0; i < 30; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
  };
}

test('a display change restarts the capture with the re-resolved monitor and keeps the share', async () => {
  const clock = fakeTimers();
  const started: string[][] = [];
  const statuses: CaptureStatus[] = [];
  let displays = [{ id: '1', rect: { x: 0, y: 0, w: 1920, h: 1080 } }];
  const sup = createCaptureSupervisor({
    start: async (args) => {
      started.push(args);
      return { ok: true, width: 1280, height: 720 };
    },
    argsFor: (target, fps) => {
      if (target.kind !== 'monitor') return null;
      const d = pickDisplay(displays, target.displayId, target.rect);
      return d ? monitorArgs(d.rect, 1280, 720, fps) : null;
    },
    onStatus: (s) => statuses.push(s),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  sup.arm({ kind: 'monitor', displayId: '1', rect: { x: 0, y: 0, w: 1920, h: 1080 } }, 8);
  // RDP reconnect: the display comes back at a new size, events arrive in a burst.
  displays = [{ id: '1', rect: { x: 0, y: 0, w: 1280, h: 720 } }];
  sup.trigger('display-metrics-changed');
  sup.trigger('display-added');
  await clock.advance(2000);
  assert.equal(started.length, 1, 'debounced to one restart');
  assert.deepEqual(started[0], ['capture-monitor', '0', '0', '1280', '720', '1280', '720', '8']);
  assert.deepEqual(statuses.map((s) => s.state), ['recovering', 'recovered']);
  assert.equal(sup.armed(), true);
});

test('watchdog restarts a capture that stopped sending frames; repeated failure reports failed', async () => {
  const clock = fakeTimers();
  let calls = 0;
  const statuses: CaptureStatus[] = [];
  const sup = createCaptureSupervisor({
    start: async () => {
      calls++;
      return { ok: false, error: 'CreateForMonitor 0x80070057' };
    },
    argsFor: () => ['capture-window', '42', '1280', '720', '8'],
    onStatus: (s) => statuses.push(s),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delays: [0, 100, 100],
  });
  sup.arm({ kind: 'window', hwnd: '42' }, 8);
  sup.frame();
  await clock.advance(1000);
  sup.tick();
  assert.equal(calls, 0, 'frames are recent');
  await clock.advance(3500);
  sup.tick();
  await clock.advance(1000);
  assert.equal(calls, 3);
  assert.equal(statuses.at(-1)?.state, 'failed');
  assert.equal(sup.armed(), false);
});

test('stopping the share cancels a pending recovery', async () => {
  const clock = fakeTimers();
  let calls = 0;
  const sup = createCaptureSupervisor({
    start: async () => {
      calls++;
      return { ok: true, width: 2, height: 2 };
    },
    argsFor: () => ['x'],
    onStatus: () => undefined,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  sup.arm({ kind: 'window', hwnd: '1' }, 8);
  sup.trigger('unlock-screen');
  sup.disarm();
  await clock.advance(5000);
  assert.equal(calls, 0);
});

test('pickDisplay falls back to the display overlapping the old rectangle', () => {
  const ds = [
    { id: 'a', rect: { x: 0, y: 0, w: 1920, h: 1080 } },
    { id: 'b', rect: { x: 1920, y: 0, w: 1920, h: 1080 } },
  ];
  assert.equal(pickDisplay(ds, 'b', { x: 0, y: 0, w: 1, h: 1 })?.id, 'b');
  assert.equal(pickDisplay(ds, 'gone', { x: 2000, y: 100, w: 1600, h: 900 })?.id, 'b');
  assert.equal(pickDisplay(ds, 'gone', { x: 9000, y: 0, w: 10, h: 10 })?.id, 'a');
  assert.equal(pickDisplay([], 'a', { x: 0, y: 0, w: 1, h: 1 }), null);
});

test('the pump reports the helper stale reason when it exits by itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgc-'));
  const script = path.join(dir, 'fake-helper.cjs');
  fs.writeFileSync(
    script,
    `const w=4,h=2;process.stderr.write(JSON.stringify({event:'ready',width:w,height:h,source:'monitor'})+'\\n');
     const head=Buffer.alloc(20);head.writeUInt32LE(0x31434757,0);head.writeUInt32LE(w,4);head.writeUInt32LE(h,8);head.writeUInt32LE(w*4,12);head.writeUInt32LE(w*h*4,16);
     process.stdout.write(Buffer.concat([head,Buffer.alloc(w*h*4,7)]),()=>{process.stderr.write(JSON.stringify({event:'stale',why:'frozen'})+'\\n',()=>process.exit(3));});`
  );
  let frames = 0;
  const ended = new Promise<{ code: number | null; reason: string }>((resolve) => {
    const pump = createWgcPump({
      helper: () => process.execPath,
      onFrame: () => frames++,
      onEnded: resolve,
      onLog: () => undefined,
    });
    void pump.start([script]).then((r) => assert.equal(r.ok, true));
  });
  const info = await ended;
  assert.equal(info.code, 3);
  assert.equal(info.reason, 'stale frozen');
  assert.equal(frames, 1);
});

test('the helper source has the stale watch wired into the capture loop', () => {
  const c = fs.readFileSync(path.join(__dirname, '..', 'native', 'affinity-helper.c'), 'utf8');
  for (const why of ['device-lost', 'display-changed', 'session-changed', 'unlocked', 'frozen']) assert.ok(c.includes(`"${why}"`), why);
  assert.match(c, /stale_check\(&watch, device, now, lastReal\)/);
  assert.match(c, /rc = STALE_EXIT;/);
});

// ---- (5) Ink composited into the published frames ----

test('overlay ink is cropped, sent, and blended into the captured frame', () => {
  const fw = 64;
  const fh = 36;
  const ink = new Uint8ClampedArray(fw * fh * 4);
  for (let x = 10; x < 30; x++) ink.set([239, 68, 68, 255], (20 * fw + x) * 4); // opaque red line
  ink.set([0, 0, 255, 128], (5 * fw + 5) * 4); // half-transparent blue dot
  const layer = cropInk(ink, fw, fh);
  assert.deepEqual([layer.x, layer.y, layer.w, layer.h], [5, 5, 25, 16]);
  const parsed = parseInkLayer({ ...layer });
  assert.ok(parsed);
  const frame = solid(fw, fh, [255, 255, 255]);
  assert.equal(layerAlreadyInFrame(frame, fw, fh, parsed), false);
  assert.equal(compositeInkLayer(frame, fw, fh, parsed), true);
  assert.deepEqual([...frame.subarray((20 * fw + 15) * 4, (20 * fw + 15) * 4 + 3)], [239, 68, 68]);
  const dot = [...frame.subarray((5 * fw + 5) * 4, (5 * fw + 5) * 4 + 3)];
  assert.ok(dot[0]! > 100 && dot[0]! < 140 && dot[2] === 255, `blended ${dot}`);
  // A desktop whose capture already contains the overlay is not drawn twice.
  assert.equal(layerAlreadyInFrame(frame, fw, fh, parsed), true);
  // Wrong frame size: not blended (the overlay re-renders for the new size).
  assert.equal(compositeInkLayer(solid(32, 18, [0, 0, 0]), 32, 18, parsed), false);
});

test('an empty or malformed layer is ignored', () => {
  assert.equal(cropInk(new Uint8Array(16 * 16 * 4), 16, 16).w, 0);
  assert.equal(parseInkLayer({ fw: 16, fh: 16, x: 0, y: 0, w: 0, h: 0, rgba: new Uint8Array(0) }), null);
  assert.equal(parseInkLayer({ fw: 16, fh: 16, x: 10, y: 0, w: 10, h: 1, rgba: new Uint8Array(40) }), null);
  assert.equal(parseInkLayer({ fw: 16, fh: 16, x: 0, y: 0, w: 2, h: 2, rgba: new Uint8Array(3) }), null);
  assert.equal(parseInkLayer('x'), null);
});

test('the overlay is hit-testable in draw mode and pushes its ink layer to main', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /body\.annotate\.overlay:not\(\.passthrough\) \{ background: rgba\(0, 0, 0, 0\.004\); \}/);
  const ts = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'annotate.ts'), 'utf8');
  assert.match(ts, /desktop\(\)\.annotationLayer\(layer\)/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /compositeInkLayer\(frame\.rgba, frame\.width, frame\.height, inkLayer\)/);
});

// ---- (2) Computer sound in Video mode ----

test('share audio follows Video mode unless the teacher chose', () => {
  assert.equal(wantShareAudio({ choice: 'auto', videoMode: true, askedAtStart: false, excludesOwnOutput: true }), true);
  assert.equal(wantShareAudio({ choice: 'auto', videoMode: false, askedAtStart: false, excludesOwnOutput: true }), false);
  assert.equal(wantShareAudio({ choice: 'auto', videoMode: false, askedAtStart: true, excludesOwnOutput: true }), true);
  assert.equal(wantShareAudio({ choice: 'off', videoMode: true, askedAtStart: true, excludesOwnOutput: true }), false);
  assert.equal(wantShareAudio({ choice: 'on', videoMode: false, askedAtStart: false, excludesOwnOutput: true }), true);
  assert.equal(toggleShareAudio(true), 'off');
  assert.equal(toggleShareAudio(false), 'on');
});

test('loopback uses desktop getUserMedia (no user gesture needed), not getDisplayMedia first', () => {
  const c = desktopLoopbackConstraints() as unknown as { audio: { mandatory: { chromeMediaSource: string } }; video: { mandatory: { chromeMediaSource: string } } };
  assert.equal(c.audio.mandatory.chromeMediaSource, 'desktop');
  assert.equal(c.video.mandatory.chromeMediaSource, 'desktop');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'classSession.ts'), 'utf8');
  const body = src.slice(src.indexOf('private captureSystemAudio'), src.indexOf('private async discardAudio'));
  assert.ok(body.indexOf('getUserMedia(desktopLoopbackConstraints())') < body.indexOf(".getDisplayMedia("));
  assert.doesNotMatch(src, /why === 'manual'\) \{\s*\/\/ Best effort/);
});

// ---- (4) Video panel: no unlabeled blank tile ----

test('a visible student without a camera fills the slot instead of a blank tile', () => {
  // Layout 4 = teacher + 3 students. Server sample: s1, s2, s3; s3 (iPhone) has no camera.
  const live = ['s1', 's2'];
  const students = fillStudentSlots(live, ['s3', 's4'], 3);
  assert.deepEqual(students, ['s1', 's2', 's3']);
  assert.deepEqual(visibleCells(students, 4), ['__self__', 's1', 's2', 's3']);
  // Fewer students than slots: no blank cells at all.
  assert.deepEqual(visibleCells(fillStudentSlots(['s1'], [], 5), 6), ['__self__', 's1']);
  assert.deepEqual(fillStudentSlots(['s1', 's1'], ['s1', ''], 3), ['s1']);
});
