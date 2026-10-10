import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statePollMs, chatPollMs, waitingPollMs, perMinute, mergeAudience } from '../src/lib/pollPolicy';

test('students poll slowly while pushes are live, fast when not', () => {
  assert.equal(statePollMs({ role: 'student', hidden: false, pushLive: true }), 30000);
  assert.equal(statePollMs({ role: 'student', hidden: true, pushLive: true }), 60000);
  assert.equal(statePollMs({ role: 'student', hidden: false, pushLive: false }), 2000);
  assert.equal(statePollMs({ role: 'student', hidden: true, pushLive: false }), 10000);
});

test('teacher never slows down when hidden (share HUD needs counts)', () => {
  assert.equal(statePollMs({ role: 'teacher', hidden: true, pushLive: true }), 30000);
  assert.equal(statePollMs({ role: 'teacher', hidden: false, pushLive: true }), 30000);
  assert.equal(statePollMs({ role: 'teacher', hidden: true, pushLive: false }), 2000);
});

test('chat and waiting polls', () => {
  assert.equal(chatPollMs({ hidden: false, pushLive: true }), 60000);
  assert.equal(chatPollMs({ hidden: false, pushLive: false }), 3000);
  assert.equal(waitingPollMs(false), 2000);
  assert.equal(waitingPollMs(true), 6000);
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
