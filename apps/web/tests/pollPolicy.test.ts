import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statePollMs, chatPollMs, waitingPollMs, perMinute, mergeAudience, jitterMs, nudgeSpreadMs, nudgeDelayMs, NUDGE_SPREAD_MS } from '../src/lib/pollPolicy';

test('students poll slowly while pushes are live, fast when not', () => {
  assert.equal(statePollMs({ role: 'student', hidden: false, pushLive: true }), 60000);
  assert.equal(statePollMs({ role: 'student', hidden: true, pushLive: true }), 120000);
  assert.equal(statePollMs({ role: 'student', hidden: false, pushLive: false }), 5000);
  assert.equal(statePollMs({ role: 'student', hidden: true, pushLive: false }), 15000);
});

test('teacher never slows down when hidden (share HUD needs counts)', () => {
  assert.equal(statePollMs({ role: 'teacher', hidden: true, pushLive: true }), 60000);
  assert.equal(statePollMs({ role: 'teacher', hidden: false, pushLive: true }), 60000);
  assert.equal(statePollMs({ role: 'teacher', hidden: true, pushLive: false }), 2000);
});

test('chat and waiting polls', () => {
  assert.equal(chatPollMs({ hidden: false, pushLive: true }), 60000);
  assert.equal(chatPollMs({ hidden: false, pushLive: false }), 3000);
  assert.equal(waitingPollMs(false), 3000);
  assert.equal(waitingPollMs(true), 8000);
});

test('per-minute helper and nudge merge', () => {
  assert.equal(perMinute(2000), 30);
  assert.equal(perMinute(6000), 10);
  assert.equal(mergeAudience('teacher', 'teacher'), 'teacher');
  assert.equal(mergeAudience('teacher', 'all'), 'all');
  assert.equal(mergeAudience(undefined, 'teacher'), 'teacher');
});

test('mute push decoding', async () => {
  const { decodeMutePush } = await import('../src/hooks/useRoomState');
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  assert.equal(decodeMutePush(dec, enc.encode(JSON.stringify({ v: 1, type: 'mute', muted: false }))), false);
  assert.equal(decodeMutePush(dec, enc.encode(JSON.stringify({ v: 1, type: 'mute', muted: true }))), true);
  assert.equal(decodeMutePush(dec, enc.encode(JSON.stringify({ v: 1, type: 'state' }))), null);
  assert.equal(decodeMutePush(dec, enc.encode('nope')), null);
});

test('jitterMs spreads ±20% around the period', () => {
  assert.equal(jitterMs(5000, 0.2, 0), 4000);
  assert.equal(jitterMs(5000, 0.2, 0.5), 5000);
  assert.equal(jitterMs(5000, 0.2, 0.999999), 6000);
});

test('class-wide nudges carry a spread; students wait inside it, teachers do not', () => {
  assert.equal(nudgeSpreadMs('all', {}), NUDGE_SPREAD_MS);
  assert.equal(nudgeSpreadMs('all', { STATE_PUSH_SPREAD_MS: '0' }), 0);
  assert.equal(nudgeSpreadMs('teacher', {}), 0);
  assert.equal(nudgeSpreadMs({ participantIds: ['a'] }, {}), 0);
  assert.equal(nudgeDelayMs({ v: 1, type: 'state', spread: 3000 }, 'teacher', 0.9), 0);
  assert.equal(nudgeDelayMs({ v: 1, type: 'state', spread: 3000 }, 'student', 0.5), 1500);
  assert.equal(nudgeDelayMs({ v: 1, type: 'state' }, 'student', 0.5), 0); // old servers: refetch now
  assert.equal(nudgeDelayMs({ spread: 1e9 }, 'student', 0.5), 5000); // capped
});
