import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScreenToken, refreshInitLine, screenTokenPath, sidecarInit } from '../src/shared/sidecar';
import { clampToArea, fitToolbar } from '../src/shared/toolbarLayout';
import { presentStudents } from '../src/shared/classLogic';
import { applyDrawBytes, inkPoint } from '../src/shared/studentInk';
import { createCaptureSupervisor, type CaptureStatus } from '../src/main/captureSupervisor';

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);

// —— Fix 1: fresh screen token on every sidecar reconnect ——

test('screen token path only for plain room codes', () => {
  assert.equal(screenTokenPath('ab12cd'), '/api/rooms/AB12CD/screen-token');
  assert.equal(screenTokenPath('../x'), null);
  assert.equal(screenTokenPath(undefined), null);
});

test('parseScreenToken accepts only a 2xx with token + ws url', () => {
  assert.deepEqual(parseScreenToken({ status: 200, data: { token: TOKEN_A, url: 'wss://x' } }), { token: TOKEN_A, url: 'wss://x' });
  assert.equal(parseScreenToken({ status: 409, data: { token: TOKEN_A, url: 'wss://x' } }), null);
  assert.equal(parseScreenToken({ status: 200, data: { token: 'short', url: 'wss://x' } }), null);
  assert.equal(parseScreenToken(null), null);
});

test('refreshInitLine swaps the expired token and keeps the share settings', () => {
  const init = sidecarInit({ url: 'wss://x', token: TOKEN_A, audio: false, fps: 5 }, { slidesFps: 8, videoFps: 24, maxBitrate: 1, videoBitrate: 2 })!;
  const next = JSON.parse(refreshInitLine(JSON.stringify(init), { token: TOKEN_B, url: 'wss://y' }, { audio: true })!);
  assert.equal(next.token, TOKEN_B);
  assert.equal(next.url, 'wss://y');
  assert.equal(next.fps, 5);
  assert.equal(next.audio, true);
  assert.equal(refreshInitLine('not json', { token: TOKEN_B, url: 'wss://y' }), null);
});

test('supervisor: each recovery attempt runs start (where the token is refreshed); all failing reports failed', async () => {
  const statuses: CaptureStatus[] = [];
  let calls = 0;
  const sup = createCaptureSupervisor({
    start: async () => {
      calls += 1;
      return { ok: false, error: 'screen-token' };
    },
    argsFor: () => ['capture-monitor'],
    onStatus: (s) => statuses.push(s),
    delays: [0, 0, 0],
    debounceMs: 0,
  });
  sup.arm({ kind: 'monitor', displayId: '1', rect: { x: 0, y: 0, w: 10, h: 10 } }, 8);
  sup.trigger('sidecar exit');
  await new Promise((r) => setTimeout(r, 20));
  await sup.idle();
  assert.equal(calls, 3);
  assert.equal(statuses.at(-1)?.state, 'failed');
  assert.equal(sup.armed(), false);
});

test('supervisor: a fresh-token restart recovers', async () => {
  const statuses: CaptureStatus[] = [];
  const tokens: string[] = [];
  let current = TOKEN_A;
  const sup = createCaptureSupervisor({
    start: async () => {
      current = TOKEN_B; // refreshed before reconnecting
      tokens.push(current);
      return { ok: true, width: 1280, height: 720 };
    },
    argsFor: () => ['capture-monitor'],
    onStatus: (s) => statuses.push(s),
    delays: [0],
    debounceMs: 0,
  });
  sup.arm({ kind: 'monitor', displayId: '1', rect: { x: 0, y: 0, w: 10, h: 10 } }, 8);
  sup.trigger('no-frames');
  await new Promise((r) => setTimeout(r, 20));
  await sup.idle();
  assert.deepEqual(tokens, [TOKEN_B]);
  assert.equal(statuses.at(-1)?.state, 'recovered');
});

// —— Fix 2: annotate toolbar fits the work area ——

const AREAS = {
  '1280x768@100': { x: 0, y: 0, width: 1280, height: 728 },
  '1920x1080@100': { x: 0, y: 0, width: 1920, height: 1040 },
  '1920x1080@125': { x: 0, y: 0, width: 1536, height: 824 },
  '1920x1080@150': { x: 0, y: 0, width: 1280, height: 680 },
  'second@150': { x: 1280, y: -200, width: 1280, height: 680 },
} as Record<string, { x: number; y: number; width: number; height: number }>;

test('vertical toolbar: one column when it fits, wraps to columns when not, always inside the work area', () => {
  for (const [name, area] of Object.entries(AREAS)) {
    for (const naturalH of [600, 900, 1400]) {
      for (const pos of [{ x: area.x - 500, y: area.y - 500 }, { x: area.x + area.width + 50, y: area.y + area.height + 50 }, { x: area.x + 10, y: area.y + 10 }]) {
        const f = fitToolbar('vertical', { width: 64, height: naturalH }, area, pos);
        assert.ok(f.x >= area.x && f.y >= area.y, `${name} ${naturalH} origin inside`);
        assert.ok(f.x + f.width <= area.x + area.width && f.y + f.height <= area.y + area.height, `${name} ${naturalH} inside`);
        if (naturalH <= area.height) {
          assert.equal(f.lines, 1);
          assert.equal(f.height, naturalH);
        } else {
          assert.ok(f.lines >= 2, `${name} ${naturalH} wraps`);
          assert.ok(f.width * f.height >= 64 * naturalH, `${name} ${naturalH} room for every control`);
        }
      }
    }
  }
});

test('extra lines when the panel still overflows; horizontal wraps to rows on narrow screens', () => {
  const area = AREAS['1920x1080@150']!;
  const a = fitToolbar('vertical', { width: 64, height: 900 }, area, { x: 0, y: 0 });
  const b = fitToolbar('vertical', { width: 64, height: 900 }, area, { x: 0, y: 0 }, 1);
  assert.equal(b.lines, a.lines + 1);
  const h = fitToolbar('horizontal', { width: 1400, height: 60 }, area, { x: 0, y: 0 });
  assert.equal(h.lines, 2);
  assert.ok(h.width <= area.width);
  const wide = fitToolbar('horizontal', { width: 1040, height: 60 }, AREAS['1920x1080@100']!, { x: 0, y: 0 });
  assert.equal(wide.lines, 1);
  assert.equal(wide.width, 1040);
});

test('clampToArea keeps a dragged window fully on screen on every edge', () => {
  const area = { x: 0, y: 0, width: 1280, height: 680 };
  assert.deepEqual(clampToArea({ x: -30, y: 10, width: 64, height: 500 }, area), { x: 0, y: 10, width: 64, height: 500 });
  assert.deepEqual(clampToArea({ x: 1250, y: 600, width: 64, height: 500 }, area), { x: 1216, y: 180, width: 64, height: 500 });
  assert.deepEqual(clampToArea({ x: 10, y: -90, width: 64, height: 900 }, area), { x: 10, y: 0, width: 64, height: 680 });
});

// —— Fix 5: departed students leave the rotation ——

test('presentStudents drops admitted students no longer in the room', () => {
  const got = presentStudents(['s1', 'load171', 's2', 'load207'], new Set(['s1', 's2', 'teacher']));
  assert.deepEqual([...got], ['s1', 's2']);
});

// —— Fix 6: student strokes reach the overlay canvas ——

test('server draw packets (bytes) → strokes → overlay pixels, incl. region shares', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  let strokes = applyDrawBytes([], enc({ v: 1, t: 'pts', id: 'abcd1234', by: 'student_1', name: 'Asha', c: 'red', from: 0, pts: [0.1, 0.2, 0.3, 0.4] })).strokes;
  strokes = applyDrawBytes(strokes, enc({ v: 1, t: 'pts', id: 'abcd1234', by: 'student_1', name: 'Asha', c: 'red', from: 4, pts: [0.5, 0.6] })).strokes;
  assert.equal(strokes.length, 1);
  assert.deepEqual(strokes[0]!.pts, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  assert.equal(applyDrawBytes(strokes, new TextEncoder().encode('{bad')).changed, false);
  // whole screen 1920x1080
  assert.deepEqual(inkPoint(0.5, 0.5, { x: 0, y: 0, w: 1, h: 1 }, 1920, 1080), { x: 960, y: 540 });
  // region share: right half of the monitor
  assert.deepEqual(inkPoint(0, 1, { x: 0.5, y: 0, w: 0.5, h: 1 }, 1920, 1080), { x: 960, y: 1080 });
  strokes = applyDrawBytes(strokes, enc({ v: 1, t: 'del', id: 'abcd1234' })).strokes;
  assert.equal(strokes.length, 0);
});

// —— Source guards for renderer wiring (no DOM in node tests) ——
import { readFileSync } from 'node:fs';
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('sidecar share failure clears the sharing UI and offers a restart; rejoin resumes', () => {
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /this\.sharing && \(this\.wgcHandle \|\| this\.viaSidecar\)/);
  assert.match(cs, /status\.state === 'failed'\) \{\s*void this\.shareFailed/);
  assert.match(cs, /shareStopped: this\.shareStopped && !this\.sharing/);
  assert.match(cs, /resumeShare = this\.sharing && this\.lastShare/);
  assert.match(cs, /code: this\.code,/);
  const main = src('main/main.ts');
  assert.match(main, /start: \(args\) => supervisedStart\(args\)/);
  assert.match(main, /refreshSidecarToken\(\)/);
  assert.match(src('renderer/engine.ts'), /Share stopped — click to restart/);
});

test('helper failure falls back to Chromium capture instead of retrying the helper', () => {
  assert.match(src('renderer/classSession.ts'), /chromiumDesktopTrack\(input\.source\.id\)/);
  assert.match(src('main/main.ts'), /class window falls back to Chromium capture/);
});

test('reply privately focuses the reply box and shows the recipient', () => {
  const tv = src('renderer/teacherViews.tsx');
  assert.match(tv, /Replying privately to <strong>\{toName\}<\/strong>/);
  assert.match(tv, /focusReply\.current = true/);
  assert.match(tv, /resolveChatRecipient\(replyPick \?\?/);
});
