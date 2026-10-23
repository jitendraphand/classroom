import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeStickySpeakers, freshSpeakerPins, STICKY_SPEAKER_TTL_MS } from '../src/lib/classSlots';
import { classroomReconnectPolicy, isOwnStaleDuplicate, rejoinDelayMs, rejoinOutcome, shouldAutoRejoin, NO_REJOIN_REASONS } from '../src/lib/rejoinPolicy';
import { envWaitingRoomDefault, resolveWaitingRoomDefault } from '../src/lib/waitingRoomPref';
import { parseMediaServers, pickLeastLoaded } from '../src/lib/mediaServers';

test('mosaic: sticky speakers expire after the TTL', () => {
  const now = 100_000;
  const lastSpoke = new Map([
    ['a', now - 1000],
    ['b', now - STICKY_SPEAKER_TTL_MS - 1],
  ]);
  const out = activeStickySpeakers({ lastSpoke, now, pool: ['a', 'b', 'c'], pins: [], studentSlots: 5 });
  assert.deepEqual(out, ['a']);
});

test('mosaic: speakers never take every tile when more students publish than fit', () => {
  const now = 1_000_000;
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const lastSpoke = new Map(ids.map((id, i) => [id, now - i] as [string, number]));
  const out = activeStickySpeakers({ lastSpoke, now, pool: ids, pins: [], speakingId: 'a', studentSlots: 5 });
  // 5 tiles: 1 active speaker + 3 sticky, 1 tile left for rotation
  assert.equal(out.length, 3);
  assert.ok(!out.includes('a'));
  // fewer students than tiles: everyone may stay
  const few = activeStickySpeakers({ lastSpoke, now, pool: ['b', 'c'], pins: [], studentSlots: 5 });
  assert.deepEqual(few.sort(), ['b', 'c']);
});

test('sample: speaker pins expire and leave one rotating slot', () => {
  const now = 50_000;
  const raw = { a: String(now - 1000), b: String(now - 2000), c: String(now - 30_000), d: String(now - 10), e: String(now - 20), f: String(now - 30) };
  const fresh = freshSpeakerPins(raw, { now, ttlMs: 18_000, max: 5, admitted: 9, teacherPinned: 0 });
  assert.ok(!fresh.includes('c'));
  assert.equal(fresh.length, 4);
  assert.deepEqual(freshSpeakerPins(raw, { now, ttlMs: 18_000, max: 5, admitted: 4, teacherPinned: 0 }).length, 5);
});

test('rejoin: only real drops rejoin, with capped backoff', () => {
  assert.equal(shouldAutoRejoin(undefined, { leaving: false }), true);
  assert.equal(shouldAutoRejoin(0, { leaving: false }), true); // UNKNOWN_REASON (network)
  assert.equal(shouldAutoRejoin(NO_REJOIN_REASONS.CLIENT_INITIATED, { leaving: false }), false);
  assert.equal(shouldAutoRejoin(NO_REJOIN_REASONS.DUPLICATE_IDENTITY, { leaving: false }), false);
  assert.equal(shouldAutoRejoin(NO_REJOIN_REASONS.PARTICIPANT_REMOVED, { leaving: false }), false);
  assert.equal(shouldAutoRejoin(NO_REJOIN_REASONS.ROOM_DELETED, { leaving: false }), false);
  assert.equal(shouldAutoRejoin(0, { leaving: true }), false);
  const mid = () => 0.5;
  assert.equal(rejoinDelayMs(0, mid), 1000);
  assert.equal(rejoinDelayMs(3, mid), 8000);
  assert.equal(rejoinDelayMs(30, mid), 30_000);
  assert.equal(rejoinDelayMs(0, () => 0), 500);
  assert.equal(rejoinDelayMs(0, () => 0.999), 1499);
  assert.equal(rejoinOutcome(200), 'ok');
  assert.equal(rejoinOutcome(410), 'ended');
  assert.equal(rejoinOutcome(403), 'stop');
  assert.equal(rejoinOutcome(502), 'retry');
  assert.equal(rejoinOutcome(0), 'retry');
});

test('waiting room default: remembered teacher choice, else env', () => {
  assert.equal(resolveWaitingRoomDefault('1', false), true);
  assert.equal(resolveWaitingRoomDefault('0', true), false);
  assert.equal(resolveWaitingRoomDefault(null, true), true);
  assert.equal(envWaitingRoomDefault(undefined), true);
  assert.equal(envWaitingRoomDefault('off'), false);
  assert.equal(envWaitingRoomDefault('on'), true);
});

test('media servers: N=1 default from the existing env, unchanged', () => {
  const s = parseMediaServers({ LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880' } as unknown as NodeJS.ProcessEnv);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.id, 'default');
  assert.equal(s[0]!.url, undefined);
  assert.equal(s[0]!.httpUrl, 'http://127.0.0.1:7880');
  assert.equal(s[0]!.capacity, 200);
});

test('media servers: registry from LIVEKIT_SERVERS, bad entries skipped', () => {
  const env = {
    LIVEKIT_API_KEY: 'k',
    LIVEKIT_API_SECRET: 's',
    LIVEKIT_SERVERS: JSON.stringify([
      { id: 'm1', url: 'wss://m1.x', httpUrl: 'https://m1.x', capacity: 200 },
      { id: 'm2', url: 'wss://m2.x', apiKey: 'k2', apiSecret: 's2', capacity: 100 },
      { id: 'm1', url: 'wss://dup' },
      { url: 'wss://noid' },
    ]),
  } as unknown as NodeJS.ProcessEnv;
  const s = parseMediaServers(env);
  assert.deepEqual(s.map((x) => x.id), ['m1', 'm2']);
  assert.equal(s[1]!.httpUrl, 'https://m2.x');
  assert.equal(s[1]!.apiKey, 'k2');
  assert.equal(parseMediaServers({ ...env, LIVEKIT_SERVERS: 'not json' }).length, 1);
});

test('media servers: least loaded by students/capacity, draining skipped', () => {
  const s = parseMediaServers({
    LIVEKIT_API_KEY: 'k',
    LIVEKIT_API_SECRET: 's',
    LIVEKIT_SERVERS: JSON.stringify([
      { id: 'a', url: 'wss://a', capacity: 200 },
      { id: 'b', url: 'wss://b', capacity: 100 },
    ]),
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(pickLeastLoaded(s, { a: 100, b: 40 }).id, 'b'); // 0.5 vs 0.4
  assert.equal(pickLeastLoaded(s, { a: 60, b: 40 }).id, 'a'); // 0.3 vs 0.4
  assert.equal(pickLeastLoaded(s, {}).id, 'a');
  assert.equal(pickLeastLoaded(s, { a: 0, b: 0 }, new Set(['a'])).id, 'b');
  assert.equal(pickLeastLoaded(s, {}, new Set(['a', 'b'])).id, 'a');
});

test('SDK reconnect policy: jittered, bounded, gives up for a fresh rejoin', () => {
  const lo = classroomReconnectPolicy(() => 0);
  const hi = classroomReconnectPolicy(() => 0.999);
  assert.ok(lo.nextRetryDelayInMs({ retryCount: 0, elapsedMs: 0 })! >= 300);
  assert.ok(hi.nextRetryDelayInMs({ retryCount: 0, elapsedMs: 0 })! <= 1500);
  assert.ok(hi.nextRetryDelayInMs({ retryCount: 9, elapsedMs: 30_000 })! <= 15_000);
  assert.ok(lo.nextRetryDelayInMs({ retryCount: 9, elapsedMs: 30_000 })! >= 7_500);
  assert.equal(lo.nextRetryDelayInMs({ retryCount: 3, elapsedMs: 61_000 }), null);
  assert.equal(isOwnStaleDuplicate({ rejoining: true, connectedAt: null, now: 0 }), true);
  assert.equal(isOwnStaleDuplicate({ rejoining: false, connectedAt: 1000, now: 5000 }), true);
  assert.equal(isOwnStaleDuplicate({ rejoining: false, connectedAt: 1000, now: 60_000 }), false);
});

test('draw-allow push: server-only, applied locally', async () => {
  const { decodeSignalPacket, signalPacketTrusted, applyDrawAllowPush } = await import('../src/lib/realtimePackets');
  const pkt = decodeSignalPacket({ v: 1, type: 'draw-allow', on: true, participantId: 'p1', identity: 'student_p1', name: 'Asha', until: 99 });
  assert.ok(pkt && pkt.type === 'draw-allow');
  assert.equal(signalPacketTrusted(pkt!, 'student_p1', 'p1'), false);
  assert.equal(signalPacketTrusted(pkt!, undefined, 'p1'), true);
  const s0 = { me: { id: 'p1', canDraw: false }, drawHolders: [], drawHolder: null };
  const s1 = applyDrawAllowPush(s0, pkt as never);
  assert.equal(s1.me?.canDraw, true);
  assert.equal(s1.drawHolders.length, 1);
  const s2 = applyDrawAllowPush(s1, { ...(pkt as object), on: false } as never);
  assert.equal(s2.me?.canDraw, false);
  assert.equal(s2.drawHolders.length, 0);
});
