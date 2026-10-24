import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clientConnectDelayMs,
  isNegotiationError,
  joinConnectRate,
  joinSpreadMaxMs,
  paceSlot,
  withNegotiationRetry,
} from '../src/lib/joinPacingLogic';

test('paceSlot: a wave is spaced at the rate; a quiet room connects at once', () => {
  const gap = 25; // 40/s
  let next = 0;
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = paceSlot(1000, next, gap, 15_000);
    delays.push(r.delay);
    next = r.next;
  }
  assert.deepEqual(delays, [0, 25, 50, 75, 100]);
  // later, idle again
  assert.equal(paceSlot(10_000, next, gap, 15_000).delay, 0);
});

test('paceSlot: never more than the max spread', () => {
  const r = paceSlot(0, 60_000, 25, 15_000);
  assert.equal(r.delay, 15_000);
  assert.equal(r.next, 15_025);
});

test('pacing env: defaults 40/s within 15 s; 0 disables', () => {
  assert.equal(joinConnectRate({}), 40);
  assert.equal(joinConnectRate({ JOIN_CONNECT_RATE: '100' }), 100);
  assert.equal(joinConnectRate({ JOIN_CONNECT_RATE: '-1' }), 40);
  assert.equal(joinSpreadMaxMs({}), 15_000);
  assert.equal(joinSpreadMaxMs({ JOIN_SPREAD_MAX_MS: '0' }), 0);
});

test('client connect delay is clamped; old servers mean no wait', () => {
  assert.equal(clientConnectDelayMs({}), 0);
  assert.equal(clientConnectDelayMs({ connectDelayMs: 1234.4 }), 1234);
  assert.equal(clientConnectDelayMs({ connectDelayMs: 1e9 }), 20_000);
  assert.equal(clientConnectDelayMs({ connectDelayMs: 'x' }), 0);
  assert.equal(clientConnectDelayMs(null), 0);
});

test('isNegotiationError recognises LiveKit publish timeouts only', () => {
  assert.ok(isNegotiationError({ name: 'NegotiationError', message: 'negotiation timed out' }));
  assert.ok(isNegotiationError(new Error('publication of local track timed out')));
  assert.ok(!isNegotiationError(new Error('Permission denied')));
  assert.ok(!isNegotiationError(null));
});

test('withNegotiationRetry: retries a timeout, unpublishing first, then succeeds', async () => {
  let calls = 0;
  let cleaned = 0;
  const sleeps: number[] = [];
  const out = await withNegotiationRetry(
    async () => {
      if (++calls < 3) throw Object.assign(new Error('negotiation timed out'), { name: 'NegotiationError' });
      return 'ok';
    },
    { beforeRetry: () => void cleaned++, sleep: async (ms) => void sleeps.push(ms), rnd: () => 0.5 }
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.equal(cleaned, 2);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('withNegotiationRetry: other errors and exhausted retries rethrow; cancelled stops', async () => {
  let calls = 0;
  await assert.rejects(withNegotiationRetry(async () => { calls++; throw new Error('Permission denied'); }, { sleep: async () => {} }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withNegotiationRetry(async () => { calls++; throw new Error('negotiation timed out'); }, { sleep: async () => {} }));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withNegotiationRetry(async () => { calls++; throw new Error('negotiation timed out'); }, { sleep: async () => {}, shouldContinue: () => false }));
  assert.equal(calls, 1);
});

test('token route paces students only; client waits before connecting', () => {
  const route = readFileSync(new URL('../src/app/api/rooms/[code]/token/route.ts', import.meta.url), 'utf8');
  assert.match(route, /isTeacher \? 0 : await nextConnectDelayMs\(\)/);
  const room = readFileSync(new URL('../src/components/classroom/ClassroomRoom.tsx', import.meta.url), 'utf8');
  assert.equal((room.match(/await sleepConnectDelay\(/g) || []).length, 2);
  assert.equal((room.match(/withNegotiationRetry\(/g) || []).length, 2);
  // students still never auto-subscribe (no classmates' video)
  assert.match(room, /autoSubscribe: isTeacher/);
});
