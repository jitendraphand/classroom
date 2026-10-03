import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, sessionStatus, newSessionId } from '../src/lib/sessionTokens';
import {
  endedSessionCopy,
  isEndedReason,
  loginHref,
  safeNextPath,
  shouldCheckAfter401,
} from '../src/lib/sessionClient';
import { createGraceTimers, TEACHER_ABSENCE_GRACE_MS } from '../src/lib/graceTimer';
import {
  handlePresenceEvent,
  type PresenceDeps,
  type PresenceParticipant,
} from '../src/lib/teacherPresenceLogic';

const secret = new TextEncoder().encode('y'.repeat(48));

// ---------------------------------------------------------------- session id

test('the session id rides in the token and must match the active one', async () => {
  const sid = newSessionId();
  const t = await signSession('teacher', 't1', 3, { sid }, secret);
  const claims = (await verifySession(t, 'teacher', secret))!;
  assert.equal(claims.sid, sid);
  assert.equal(sessionStatus(claims, { sessionVersion: 3, activeSessionId: sid }), 'ok');
  // A newer login on another device stored a different id.
  assert.equal(sessionStatus(claims, { sessionVersion: 3, activeSessionId: newSessionId() }), 'signed_in_elsewhere');
  // Logged out (cleared) → this token no longer works.
  assert.equal(sessionStatus(claims, { sessionVersion: 3, activeSessionId: null }), 'signed_out');
});

test('password change / disable keep their own reasons, checked before the session id', () => {
  assert.equal(sessionStatus({ sv: 1, sid: 'a' }, { sessionVersion: 2, activeSessionId: 'b' }), 'revoked');
  assert.equal(sessionStatus({ sv: 1, sid: 'a' }, { sessionVersion: 1, activeSessionId: 'a', disabled: true }), 'disabled');
  assert.equal(sessionStatus({ sv: 0, sid: 'a' }, null), 'missing');
});

test('tokens from before single sessions (no sid) are not accepted: sign in again', async () => {
  const old = await signSession('admin', 'a1', 0, {}, secret);
  const claims = (await verifySession(old, 'admin', secret))!;
  assert.equal(sessionStatus(claims, { sessionVersion: 0, activeSessionId: null }), 'expired');
  assert.equal(sessionStatus(claims, { sessionVersion: 0, activeSessionId: 'x' }), 'expired');
  assert.equal(sessionStatus({ sv: 0, sid: '' }, { sessionVersion: 0, activeSessionId: '' }), 'expired');
});

test('new session ids are unique and opaque', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------- client helpers

test('ended-session copy and login links', () => {
  assert.equal(endedSessionCopy('signed_in_elsewhere').title, 'You were signed in on another device');
  assert.notEqual(endedSessionCopy('revoked').title, endedSessionCopy('signed_in_elsewhere').title);
  assert.equal(isEndedReason('signed_in_elsewhere'), true);
  assert.equal(isEndedReason('ok'), false);
  assert.equal(loginHref('signed_in_elsewhere', '/classroom/S3TDTK'), '/login?reason=signed_in_elsewhere&next=%2Fclassroom%2FS3TDTK');
  assert.equal(loginHref(undefined, null), '/login');
  assert.equal(loginHref('bogus', '//evil.example'), '/login');
});

test('post-login redirect only to same-site paths', () => {
  assert.equal(safeNextPath('/teacher/dashboard'), '/teacher/dashboard');
  assert.equal(safeNextPath('//evil.example/x'), null);
  assert.equal(safeNextPath('/\\evil.example'), null);
  assert.equal(safeNextPath('https://evil.example'), null);
  assert.equal(safeNextPath('/login?next=/x'), null);
});

test('only same-origin app API 401s trigger a session check', () => {
  const o = 'https://13-201-89-150.sslip.io';
  assert.equal(shouldCheckAfter401('/api/rooms/ABC/state', o), true);
  assert.equal(shouldCheckAfter401(`${o}/api/teacher/schedule`, o), true);
  assert.equal(shouldCheckAfter401('/api/auth/login', o), false);
  assert.equal(shouldCheckAfter401('/api/auth/status', o), false);
  assert.equal(shouldCheckAfter401('https://livekit.example/rtc/validate', o), false);
  assert.equal(shouldCheckAfter401('/classroom/ABC', o), false);
});

// ---------------------------------------------------------------- grace timer

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('grace timer fires after the delay unless cancelled', async () => {
  const clock = fakeClock();
  const g = createGraceTimers({ delayMs: TEACHER_ABSENCE_GRACE_MS, ...clock });
  let fired = 0;
  g.schedule('A', () => {
    fired++;
  });
  clock.advance(14_999);
  await flush();
  assert.equal(fired, 0);
  assert.equal(g.isPending('A'), true);
  clock.advance(1);
  await flush();
  assert.equal(fired, 1);
  assert.equal(g.isPending('A'), false);

  g.schedule('A', () => {
    fired++;
  });
  clock.advance(10_000);
  assert.equal(g.cancel('A'), true);
  clock.advance(10_000);
  await flush();
  assert.equal(fired, 1);
  assert.equal(g.cancel('A'), false);
});

test('rescheduling restarts the grace period; keys are independent', async () => {
  const clock = fakeClock();
  const g = createGraceTimers({ delayMs: 15_000, ...clock });
  const fired: string[] = [];
  g.schedule('A', () => void fired.push('A1'));
  clock.advance(10_000);
  g.schedule('A', () => void fired.push('A2'));
  g.schedule('B', () => void fired.push('B'));
  clock.advance(10_000);
  await flush();
  assert.deepEqual(fired, []);
  clock.advance(5_000);
  await flush();
  assert.deepEqual(fired.sort(), ['A2', 'B']);
});

// ---------------------------------------------------------------- presence + grace

const ROOM = 'classroom_ABC234_0123456789abcdef';
const teacherA: PresenceParticipant = { identity: 'teacher_t1_ABC234', sid: 'PA_A', state: 2 };
const teacherB: PresenceParticipant = { identity: 'teacher_t1_ABC234', sid: 'PA_B', state: 2 };
const student: PresenceParticipant = { identity: 'student_s1', sid: 'PA_s1', state: 2 };

function graceDeps(participants: { list: PresenceParticipant[] }) {
  const clock = fakeClock();
  const timers = createGraceTimers({ delayMs: TEACHER_ABSENCE_GRACE_MS, ...clock });
  const calls = { recorded: [] as boolean[], applied: [] as boolean[], grace: 0 };
  const deps: PresenceDeps = {
    findRoom: async (code) => ({ code, sessionId: '0123456789abcdef', status: 'LIVE' }),
    listParticipants: async () => participants.list,
    isTeacherPresent: async () => true,
    recordPresence: async (_r, p) => void calls.recorded.push(p),
    applyStudentMicLock: async (_r, p) => void calls.applied.push(p),
    deferAbsence: (r, confirm) => timers.schedule(r.code, confirm),
    cancelAbsence: (r) => void timers.cancel(r.code),
    recordGrace: async () => void calls.grace++,
  };
  return { deps, calls, clock, timers };
}

test('teacher drops: students are not locked during the 15 s grace, then locked', async () => {
  const state = { list: [student] };
  const { deps, calls, clock } = graceDeps(state);
  const out = await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacherA }, deps);
  assert.deepEqual(out, { handled: true, code: 'ABC234', teacherPresent: true, applied: 'deferred' });
  assert.deepEqual(calls.applied, []);
  assert.equal(calls.grace, 1);
  clock.advance(TEACHER_ABSENCE_GRACE_MS);
  await flush();
  assert.deepEqual(calls.recorded, [false]);
  assert.deepEqual(calls.applied, [false]);
});

test('teacher switches device within the grace: no lock at all', async () => {
  const state = { list: [student] };
  const { deps, calls, clock, timers } = graceDeps(state);
  await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacherA }, deps);
  clock.advance(6_000);
  state.list = [student, teacherB];
  await handlePresenceEvent({ event: 'participant_joined', room: { name: ROOM }, participant: teacherB }, deps);
  assert.equal(timers.isPending('ABC234'), false);
  clock.advance(20_000);
  await flush();
  assert.deepEqual(calls.applied, [true]);
  assert.deepEqual(calls.recorded, [true]);
});

test('device B kicks A (duplicate identity): A leaving while B is connected never defers or locks', async () => {
  const state = { list: [student, teacherB] };
  const { deps, calls } = graceDeps(state);
  const out = await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacherA }, deps);
  assert.deepEqual(out, { handled: true, code: 'ABC234', teacherPresent: true, applied: 'all' });
  assert.deepEqual(calls.applied, [true]);
  assert.equal(calls.grace, 0);
});

test('confirm re-checks the SFU: teacher back without a join event → no lock', async () => {
  const state = { list: [student] };
  const { deps, calls, clock } = graceDeps(state);
  await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacherA }, deps);
  state.list = [student, teacherB];
  clock.advance(TEACHER_ABSENCE_GRACE_MS);
  await flush();
  assert.deepEqual(calls.applied, []);
});
