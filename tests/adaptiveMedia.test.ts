import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, nextState, levelProfile, busyFraction, cpuTimes } from '../src/shared/adaptiveCapture';
import { parseMediaPrefs, serializeMediaPrefs } from '../src/shared/mediaPrefs';

test('two-core PCs start reduced', () => {
  assert.equal(initialState(2).level, 1);
  assert.equal(initialState(8).level, 0);
});

test('steps down after sustained load, up after sustained calm', () => {
  let s = initialState(4);
  s = nextState(s, 0.95);
  assert.equal(s.level, 0);
  s = nextState(s, 0.95);
  assert.equal(s.level, 1);
  s = nextState(nextState(s, 0.9), 0.9);
  assert.equal(s.level, 2);
  s = nextState(nextState(s, 0.99), 0.99);
  assert.equal(s.level, 2);
  for (let i = 0; i < 4; i++) s = nextState(s, 0.3);
  assert.equal(s.level, 2);
  s = nextState(s, 0.3);
  assert.equal(s.level, 1);
});

test('middle load resets counters (hysteresis)', () => {
  let s = nextState(initialState(4), 0.95);
  s = nextState(s, 0.7);
  s = nextState(s, 0.95);
  assert.equal(s.level, 0);
});

test('level profiles', () => {
  assert.deepEqual(levelProfile(0, 8), { maxHeight: 0, fps: 8 });
  assert.deepEqual(levelProfile(1, 8), { maxHeight: 900, fps: 6 });
  assert.deepEqual(levelProfile(2, 30), { maxHeight: 720, fps: 15 });
  assert.equal(levelProfile(2, 8).fps, 4);
});

test('cpu busy fraction', () => {
  const t = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  const a = cpuTimes([t(100, 100), t(100, 100)]);
  const b = cpuTimes([t(190, 110), t(190, 110)]);
  assert.equal(busyFraction(a, b), 0.9);
  assert.ok(Number.isNaN(busyFraction(a, a)));
});

test('media prefs parse with defaults', () => {
  assert.deepEqual(parseMediaPrefs(null), { mic: true, cam: false });
  assert.deepEqual(parseMediaPrefs('junk'), { mic: true, cam: false });
  assert.deepEqual(parseMediaPrefs(serializeMediaPrefs({ mic: false, cam: true })), { mic: false, cam: true });
});

import { WhiteboardSession } from '../src/shared/web/whiteboard/session';
import { filterRelayedOps } from '../src/renderer/whiteboardHost';

test('windows whiteboard drops relayed student ops on teacher items', () => {
  const s = new WhiteboardSession(undefined, true);
  const p = { v: 1, t: 'ops', by: 'student_1', ops: [{ k: 'clear' }] } as never;
  assert.equal(filterRelayedOps(s, p), false);
  const q = { v: 1, t: 'ops', ops: [{ k: 'clear' }] } as never;
  assert.equal(filterRelayedOps(s, q), true);
});
