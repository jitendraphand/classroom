import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt } from 'jose';
import { handleListLive, handleLiveDetail, handleObserverToken, type AdminGuard } from '../src/lib/adminLiveApi';
import {
  createObserverToken,
  observerGrant,
  observerIdentity,
  OBSERVER_PREVIEW_TTL,
} from '../src/lib/livekit';
import {
  formatElapsed,
  isOngoingClass,
  parseObserverMode,
  summarizeRoomParticipants,
  type LiveClass,
} from '../src/lib/liveClassesLogic';
import { isTeacherIdentity, presenceActionFor } from '../src/lib/teacherPresenceLogic';

const unauthorized: AdminGuard = async () => ({
  res: new Response(JSON.stringify({ error: 'Admin sign-in required' }), { status: 401 }),
});
const asAdmin: AdminGuard = async () => ({ admin: { id: 'adm1', name: 'Head', email: 'h@x.org' } });

const sample: LiveClass = {
  code: 'ABC123',
  sessionId: 's1',
  classSessionId: 'cs1',
  title: 'Maths · 7-A',
  subject: 'Maths',
  gradeDivision: '7-A',
  teacherName: 'T',
  startedAt: new Date(0).toISOString(),
  studentCount: 3,
  teacherConnected: true,
  countSource: 'livekit',
};
const detail = { liveClass: sample, roomName: 'classroom_ABC123_s1', students: [] };

function spy<T extends unknown[], R>(impl: (...a: T) => R) {
  const calls: T[] = [];
  const fn = (...a: T) => {
    calls.push(a);
    return impl(...a);
  };
  return Object.assign(fn, { calls });
}

// ---------------------------------------------------------------- auth / role gate

test('live list: no admin session (teacher, student or anonymous) → 401 and nothing is queried', async () => {
  const list = spy(async () => [sample]);
  const res = await handleListLive({ guard: unauthorized, list });
  assert.equal(res.status, 401);
  assert.equal(list.calls.length, 0);
});

test('live list: admin gets the classes, uncached', async () => {
  const res = await handleListLive({ guard: asAdmin, list: async () => [sample] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await res.json()).classes, [sample]);
});

test('live list: zero classes is an empty list, not an error', async () => {
  const res = await handleListLive({ guard: asAdmin, list: async () => [] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).classes, []);
});

test('live detail: 401 without admin, 404 when not live, roster for admin', async () => {
  const get = spy(async (code: string) => (code === 'ABC123' ? detail : null));
  assert.equal((await handleLiveDetail('abc123', { guard: unauthorized, get })).status, 401);
  assert.equal(get.calls.length, 0);
  assert.equal((await handleLiveDetail('nope', { guard: asAdmin, get })).status, 404);
  const ok = await handleLiveDetail('abc123', { guard: asAdmin, get });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).class.code, 'ABC123');
});

test('observer token: never minted without an admin session', async () => {
  const mint = spy(async () => ({ token: 't', identity: 'i' }));
  const res = await handleObserverToken('ABC123', { mode: 'preview' }, {
    guard: unauthorized,
    get: async () => detail,
    mint,
    serverUrl: () => 'wss://lk',
  });
  assert.equal(res.status, 401);
  assert.equal(mint.calls.length, 0);
});

test('observer token: bad mode → 400, class not live → 404', async () => {
  const deps = { guard: asAdmin, mint: async () => ({ token: 't', identity: 'i' }), serverUrl: () => 'wss://lk' };
  assert.equal((await handleObserverToken('ABC123', { mode: 'teacher' }, { ...deps, get: async () => detail })).status, 400);
  assert.equal((await handleObserverToken('ABC123', null, { ...deps, get: async () => detail })).status, 400);
  assert.equal((await handleObserverToken('ABC123', { mode: 'observe' }, { ...deps, get: async () => null })).status, 404);
});

test('observer token: minted for the current session room, as the signed-in admin', async () => {
  const mint = spy(async (o: { roomName: string; adminId: string; adminName: string; mode: string }) => {
    void o;
    return { token: 'jwt', identity: 'adminpreview_adm1_x' };
  });
  const res = await handleObserverToken('abc123', { mode: 'preview' }, {
    guard: asAdmin,
    get: async (c) => (c === 'ABC123' ? detail : null),
    mint,
    serverUrl: () => 'wss://lk',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(mint.calls[0][0], { roomName: 'classroom_ABC123_s1', adminId: 'adm1', adminName: 'Head', mode: 'preview' });
  const body = await res.json();
  assert.equal(body.token, 'jwt');
  assert.equal(body.serverUrl, 'wss://lk');
});

// ---------------------------------------------------------------- LiveKit grants

test('observer grant: hidden, subscribe-only, publishes nothing', () => {
  const g = observerGrant('classroom_ABC123_s1');
  assert.equal(g.roomJoin, true);
  assert.equal(g.room, 'classroom_ABC123_s1');
  assert.equal(g.hidden, true);
  assert.equal(g.canSubscribe, true);
  assert.equal(g.canPublish, false);
  assert.equal(g.canPublishData, false);
  assert.equal(g.canUpdateOwnMetadata, false);
  assert.deepEqual(g.canPublishSources, []);
});

test('observer identities are neither teacher_ nor student_ (no presence, attendance or mic-lock side effects)', () => {
  for (const mode of ['preview', 'observe'] as const) {
    const id = observerIdentity('adm1', mode, 'n0nce');
    assert.ok(!id.startsWith('teacher_') && !id.startsWith('student_'), id);
    assert.equal(isTeacherIdentity(id, JSON.stringify({ role: 'ADMIN' })), false);
  }
  const s = summarizeRoomParticipants([{ identity: observerIdentity('adm1', 'observe', 'x') }]);
  assert.equal(s.studentCount, 0);
  assert.equal(s.teacherConnected, false);
  // The webhook never routes an observer to the teacher-presence path.
  const a = presenceActionFor({
    event: 'participant_joined',
    room: { name: 'classroom_ABC123_s1' },
    participant: { identity: observerIdentity('adm1', 'observe', 'x'), metadata: '{"role":"ADMIN"}' },
  });
  assert.equal(a.kind, 'ignore');
});

test('signed preview token: short-lived, hidden, canPublish false; observe token 10 min', async () => {
  process.env.LIVEKIT_API_KEY = 'testkey';
  process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-0123456789';
  assert.equal(OBSERVER_PREVIEW_TTL, '2m');
  const p = await createObserverToken({ roomName: 'r1', adminId: 'adm1', adminName: 'Head', mode: 'preview' });
  const c = decodeJwt(p.token) as { exp: number; nbf?: number; iat?: number; sub: string; video: Record<string, unknown>; metadata?: string };
  const start = c.nbf ?? c.iat ?? Math.floor(Date.now() / 1000);
  assert.ok(c.exp - start <= 120, `preview ttl ${c.exp - start}s`);
  assert.equal(c.sub, p.identity);
  assert.match(p.identity, /^adminpreview_adm1_[a-f0-9]{10}$/);
  assert.equal(c.video.hidden, true);
  assert.equal(c.video.canPublish, false);
  assert.equal(c.video.canPublishData, false);
  assert.equal(c.video.canSubscribe, true);
  assert.equal(c.video.room, 'r1');
  assert.equal(JSON.parse(c.metadata!).role, 'ADMIN');

  const o = await createObserverToken({ roomName: 'r1', adminId: 'adm1', adminName: 'Head', mode: 'observe' });
  const oc = decodeJwt(o.token) as { exp: number; nbf?: number; iat?: number; video: Record<string, unknown> };
  const ostart = oc.nbf ?? oc.iat ?? Math.floor(Date.now() / 1000);
  assert.ok(oc.exp - ostart <= 600 && oc.exp - ostart > 120);
  assert.equal(oc.video.hidden, true);
  assert.equal(oc.video.canPublish, false);
  assert.notEqual(o.identity, p.identity);
});

// ---------------------------------------------------------------- counts / duration

test('student count matches attendance: unique student_ identities only', () => {
  const s = summarizeRoomParticipants([
    { identity: 'teacher_t1' },
    { identity: 'student_a' },
    { identity: 'student_a' },
    { identity: 'student_b' },
    { identity: 'adminpreview_adm1_x', metadata: '{"role":"ADMIN"}' },
  ]);
  assert.equal(s.studentCount, 2);
  assert.equal(s.teacherConnected, true);
});

test('ongoing = room open for this session, started and not ended', () => {
  const t = new Date();
  assert.equal(isOngoingClass({ status: 'LIVE', classSessionId: 'c' }, { id: 'c', startedAt: t, endedAt: null }), true);
  assert.equal(isOngoingClass({ status: 'WAITING', classSessionId: 'c' }, { id: 'c', startedAt: t, endedAt: null }), true);
  assert.equal(isOngoingClass({ status: 'ENDED', classSessionId: 'c' }, { id: 'c', startedAt: t, endedAt: null }), false);
  assert.equal(isOngoingClass({ status: 'LIVE', classSessionId: 'other' }, { id: 'c', startedAt: t, endedAt: null }), false);
  assert.equal(isOngoingClass({ status: 'LIVE', classSessionId: 'c' }, { id: 'c', startedAt: null, endedAt: null }), false);
  assert.equal(isOngoingClass({ status: 'LIVE', classSessionId: 'c' }, { id: 'c', startedAt: t, endedAt: t }), false);
});

test('elapsed time formats as mm:ss then h:mm:ss', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(-5000), '00:00');
  assert.equal(formatElapsed(65_000), '01:05');
  assert.equal(formatElapsed(59 * 60_000 + 59_999), '59:59');
  assert.equal(formatElapsed(3600_000), '1:00:00');
  assert.equal(formatElapsed(2 * 3600_000 + 3 * 60_000 + 4_000), '2:03:04');
});

test('observer mode parsing is strict', () => {
  assert.equal(parseObserverMode('preview'), 'preview');
  assert.equal(parseObserverMode('observe'), 'observe');
  assert.equal(parseObserverMode('TEACHER'), null);
  assert.equal(parseObserverMode(undefined), null);
});
