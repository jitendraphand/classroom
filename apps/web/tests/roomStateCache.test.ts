import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearStateMemo, memo, stateCacheMs } from '../src/lib/roomStateCache';

test('memo: concurrent callers share one computation (single-flight)', async () => {
  clearStateMemo();
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  };
  const rs = await Promise.all(Array.from({ length: 50 }, () => memo('k', 1000, fn)));
  assert.equal(calls, 1);
  assert.ok(rs.every((r) => r === 1));
});

test('memo: expires after the TTL; a new key (version bump) recomputes', async () => {
  clearStateMemo();
  let calls = 0;
  const fn = async () => ++calls;
  await memo('room:A:1', 1000, fn, 0);
  await memo('room:A:1', 1000, fn, 500);
  assert.equal(calls, 1);
  await memo('room:A:1', 1000, fn, 1500);
  assert.equal(calls, 2);
  await memo('room:A:2', 1000, fn, 1500);
  assert.equal(calls, 3);
});

test('memo: failures are not cached; ttl 0 disables', async () => {
  clearStateMemo();
  let calls = 0;
  await assert.rejects(memo('f', 1000, async () => { calls++; throw new Error('x'); }));
  await new Promise((r) => setImmediate(r));
  assert.equal(await memo('f', 1000, async () => ++calls), 2);
  await memo('z', 0, async () => ++calls);
  await memo('z', 0, async () => ++calls);
  assert.equal(calls, 4);
});

test('STATE_CACHE_MS: default 1 s, 0 disables, capped at 5 s', () => {
  assert.equal(stateCacheMs({}), 1000);
  assert.equal(stateCacheMs({ STATE_CACHE_MS: '0' }), 0);
  assert.equal(stateCacheMs({ STATE_CACHE_MS: '99999' }), 5000);
  assert.equal(stateCacheMs({ STATE_CACHE_MS: 'x' }), 1000);
});

test('every nudge / push bumps the room version', () => {
  const src = readFileSync(new URL('../src/lib/roomNudge.ts', import.meta.url), 'utf8');
  assert.equal((src.match(/bumpRoomVersion\(roomCode\)/g) || []).length, 4);
  assert.match(src, /spread: nudgeSpreadMs\(audience\)/);
});

test('state route: teacher view is never served from the student cache', () => {
  const src = readFileSync(new URL('../src/app/api/rooms/[code]/state/route.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(isTeacher && cacheMs > 0\) room = \(await loadRoom\(\)\)/);
  assert.match(src, /isTeacher \? await loadShared\(\)/);
});
