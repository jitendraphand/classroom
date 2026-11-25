import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt } from 'jose';
import {
  LIVEKIT_TOKEN_TTL_SECONDS,
  OBSERVER_PREVIEW_TTL,
  OBSERVER_TOKEN_TTL,
  createObserverToken,
  createParticipantToken,
  createScreenSidecarToken,
  livekitTokenTtlSeconds,
} from '../src/lib/livekit';

const KEY = 'testkey';
const SECRET = 'test-secret-that-is-long-enough-0123456789';

function jwtTtlSeconds(token: string): number {
  const c = decodeJwt(token) as { exp: number; nbf?: number; iat?: number };
  const start = c.nbf ?? c.iat ?? Math.floor(Date.now() / 1000);
  return c.exp - start;
}

test('livekitTokenTtlSeconds: default 90 minutes; env override is clamped', () => {
  assert.equal(LIVEKIT_TOKEN_TTL_SECONDS, 5400);
  assert.equal(livekitTokenTtlSeconds({}), 5400);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: '5400' }), 5400);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: '7200' }), 7200);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: '30' }), 60);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: '999999' }), 6 * 60 * 60);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: 'nope' }), 5400);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: '0' }), 5400);
  assert.equal(livekitTokenTtlSeconds({ LIVEKIT_TOKEN_TTL_SECONDS: '-10' }), 5400);
});

test('class join and screen-sidecar tokens last 90 minutes; observer tokens stay short', async () => {
  const prevKey = process.env.LIVEKIT_API_KEY;
  const prevSecret = process.env.LIVEKIT_API_SECRET;
  const prevTtl = process.env.LIVEKIT_TOKEN_TTL_SECONDS;
  process.env.LIVEKIT_API_KEY = KEY;
  process.env.LIVEKIT_API_SECRET = SECRET;
  delete process.env.LIVEKIT_TOKEN_TTL_SECONDS;
  try {
    const student = await createParticipantToken({
      role: 'STUDENT',
      roomName: 'classroom_X_s1',
      identity: 'student_abc',
      name: 'Ana',
    });
    const teacher = await createParticipantToken({
      role: 'TEACHER',
      roomName: 'classroom_X_s1',
      identity: 'teacher_t1',
      name: 'Jitendra',
    });
    const sidecar = await createScreenSidecarToken({
      roomName: 'classroom_X_s1',
      teacherIdentity: 'teacher_t1',
      name: 'Jitendra',
      participantId: 'p1',
    });
    for (const [label, token] of [
      ['student', student],
      ['teacher', teacher],
      ['sidecar', sidecar.token],
    ] as const) {
      const ttl = jwtTtlSeconds(token);
      assert.ok(ttl >= 5400 - 5 && ttl <= 5400 + 5, `${label} ttl ${ttl}s`);
    }

    assert.equal(OBSERVER_PREVIEW_TTL, '2m');
    assert.equal(OBSERVER_TOKEN_TTL, '10m');
    const preview = await createObserverToken({ roomName: 'classroom_X_s1', adminId: 'adm1', adminName: 'Head', mode: 'preview' });
    const observe = await createObserverToken({ roomName: 'classroom_X_s1', adminId: 'adm1', adminName: 'Head', mode: 'observe' });
    const previewTtl = jwtTtlSeconds(preview.token);
    const observeTtl = jwtTtlSeconds(observe.token);
    assert.ok(previewTtl > 0 && previewTtl <= 120, `preview ttl ${previewTtl}s`);
    assert.ok(observeTtl > 120 && observeTtl <= 600, `observe ttl ${observeTtl}s`);
  } finally {
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
    if (prevTtl === undefined) delete process.env.LIVEKIT_TOKEN_TTL_SECONDS;
    else process.env.LIVEKIT_TOKEN_TTL_SECONDS = prevTtl;
  }
});

test('LIVEKIT_TOKEN_TTL_SECONDS env is honoured when minting a class token', async () => {
  const prevKey = process.env.LIVEKIT_API_KEY;
  const prevSecret = process.env.LIVEKIT_API_SECRET;
  const prevTtl = process.env.LIVEKIT_TOKEN_TTL_SECONDS;
  process.env.LIVEKIT_API_KEY = KEY;
  process.env.LIVEKIT_API_SECRET = SECRET;
  process.env.LIVEKIT_TOKEN_TTL_SECONDS = '3600';
  try {
    const token = await createParticipantToken({
      role: 'STUDENT',
      roomName: 'classroom_X_s1',
      identity: 'student_abc',
      name: 'Ana',
    });
    const ttl = jwtTtlSeconds(token);
    assert.ok(ttl >= 3600 - 5 && ttl <= 3600 + 5, `env ttl ${ttl}s`);
  } finally {
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
    if (prevTtl === undefined) delete process.env.LIVEKIT_TOKEN_TTL_SECONDS;
    else process.env.LIVEKIT_TOKEN_TTL_SECONDS = prevTtl;
  }
});
