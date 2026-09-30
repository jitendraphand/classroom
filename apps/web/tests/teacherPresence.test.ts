import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { classroomGrant } from '../src/lib/livekit';
import { isCsrfExempt, checkCsrf } from '../src/lib/csrf';
import {
  handlePresenceEvent,
  isTeacherIdentity,
  parseLivekitRoomName,
  presenceActionFor,
  studentMicAllowed,
  teacherPresentAmong,
  type PresenceDeps,
  type PresenceParticipant,
} from '../src/lib/teacherPresenceLogic';

const ROOM = 'classroom_ABC234_0123456789abcdef';
const teacher: PresenceParticipant = { identity: 'teacher_t1_ABC234', sid: 'PA_t1', state: 2 };
const student: PresenceParticipant = { identity: 'student_s1', sid: 'PA_s1', state: 2 };

test('mic allowed only when teacher present and student not teacher-muted', () => {
  assert.equal(studentMicAllowed({ mutedByTeacher: false, teacherPresent: true }), true);
  assert.equal(studentMicAllowed({ mutedByTeacher: false, teacherPresent: false }), false);
  assert.equal(studentMicAllowed({ mutedByTeacher: true, teacherPresent: true }), false);
  assert.equal(studentMicAllowed({ mutedByTeacher: true, teacherPresent: false }), false);
});

test('student grant has no microphone while the teacher is absent', () => {
  const g = classroomGrant({ role: 'STUDENT', roomName: 'r', allowCamera: true, micLocked: true });
  assert.deepEqual(g.canPublishSources, [TrackSource.CAMERA]);
  const ok = classroomGrant({ role: 'STUDENT', roomName: 'r', allowCamera: true, micLocked: false });
  assert.deepEqual(ok.canPublishSources, [TrackSource.CAMERA, TrackSource.MICROPHONE]);
});

test('micLocked never affects the teacher grant', () => {
  const g = classroomGrant({ role: 'TEACHER', roomName: 'r', micLocked: true });
  assert.ok(g.canPublishSources.includes(TrackSource.MICROPHONE));
});

test('teacher identity detection', () => {
  assert.equal(isTeacherIdentity('teacher_x'), true);
  assert.equal(isTeacherIdentity('student_x', JSON.stringify({ role: 'TEACHER' })), false);
  assert.equal(isTeacherIdentity('other', JSON.stringify({ role: 'TEACHER' })), true);
  assert.equal(isTeacherIdentity('other', 'not json'), false);
});

test('presence: disconnected / just-left teacher is absent; duplicate-identity reconnect stays present', () => {
  assert.equal(teacherPresentAmong([student]), false);
  assert.equal(teacherPresentAmong([teacher, student]), true);
  assert.equal(teacherPresentAmong([{ ...teacher, state: 3 }, student]), false);
  assert.equal(teacherPresentAmong([teacher, student], { leftSid: 'PA_t1' }), false);
  const newSession = { ...teacher, sid: 'PA_t2' };
  assert.equal(teacherPresentAmong([teacher, newSession], { leftSid: 'PA_t1' }), true);
  assert.equal(teacherPresentAmong([student], { joined: teacher }), true);
});

test('room name parsing', () => {
  assert.deepEqual(parseLivekitRoomName(ROOM), { code: 'ABC234', sessionId: '0123456789abcdef' });
  assert.equal(parseLivekitRoomName('something_else'), null);
  assert.equal(parseLivekitRoomName(undefined), null);
});

test('webhook events map to presence actions', () => {
  assert.equal(presenceActionFor({ event: 'participant_joined', room: { name: ROOM }, participant: teacher }).kind, 'teacher');
  assert.equal(presenceActionFor({ event: 'participant_left', room: { name: ROOM }, participant: teacher }).kind, 'teacher');
  assert.equal(presenceActionFor({ event: 'participant_joined', room: { name: ROOM }, participant: student }).kind, 'student-joined');
  assert.equal(presenceActionFor({ event: 'participant_left', room: { name: ROOM }, participant: student }).kind, 'ignore');
  assert.equal(presenceActionFor({ event: 'room_finished', room: { name: ROOM } }).kind, 'room-finished');
  assert.equal(presenceActionFor({ event: 'track_published', room: { name: ROOM }, participant: teacher }).kind, 'ignore');
  assert.equal(presenceActionFor({ event: 'participant_joined', room: { name: 'x' }, participant: teacher }).kind, 'ignore');
});

function fakeDeps(opts: { participants: PresenceParticipant[]; sessionId?: string; status?: string; present?: boolean; listFails?: boolean }) {
  const calls = { recorded: [] as boolean[], applied: [] as Array<{ present: boolean; only?: string[] }> };
  const deps: PresenceDeps = {
    findRoom: async (code) => ({ code, sessionId: opts.sessionId ?? '0123456789abcdef', status: opts.status ?? 'LIVE' }),
    listParticipants: async () => {
      if (opts.listFails) throw new Error('boom');
      return opts.participants;
    },
    isTeacherPresent: async () => opts.present ?? false,
    recordPresence: async (_room, present) => {
      calls.recorded.push(present);
    },
    applyStudentMicLock: async (_room, present, only) => {
      calls.applied.push({ present, only });
    },
  };
  return { deps, calls };
}

test('teacher left → record absent and lock every student', async () => {
  const { deps, calls } = fakeDeps({ participants: [teacher, student] });
  const out = await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacher }, deps);
  assert.deepEqual(out, { handled: true, code: 'ABC234', teacherPresent: false, applied: 'all' });
  assert.deepEqual(calls.recorded, [false]);
  assert.deepEqual(calls.applied, [{ present: false, only: undefined }]);
});

test('teacher joined → record present and restore (mute state applied downstream)', async () => {
  const { deps, calls } = fakeDeps({ participants: [student] });
  const out = await handlePresenceEvent({ event: 'participant_joined', room: { name: ROOM }, participant: teacher }, deps);
  assert.equal(out.handled && out.teacherPresent, true);
  assert.deepEqual(calls.applied, [{ present: true, only: undefined }]);
});

test('LiveKit list failure falls back to the event itself', async () => {
  const { deps, calls } = fakeDeps({ participants: [], listFails: true });
  await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacher }, deps);
  assert.deepEqual(calls.recorded, [false]);
});

test('student joining while teacher absent is locked individually', async () => {
  const { deps, calls } = fakeDeps({ participants: [student], present: false });
  const out = await handlePresenceEvent({ event: 'participant_joined', room: { name: ROOM }, participant: student }, deps);
  assert.equal(out.handled && out.applied, 'one');
  assert.deepEqual(calls.applied, [{ present: false, only: ['student_s1'] }]);
});

test('student joining while teacher present changes nothing', async () => {
  const { deps, calls } = fakeDeps({ participants: [teacher, student], present: true });
  await handlePresenceEvent({ event: 'participant_joined', room: { name: ROOM }, participant: student }, deps);
  assert.deepEqual(calls.applied, []);
});

test('events for an old session or an ended class are ignored', async () => {
  const stale = fakeDeps({ participants: [], sessionId: 'ffffffffffffffff' });
  assert.equal((await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacher }, stale.deps)).handled, false);
  assert.deepEqual(stale.calls.applied, []);
  const ended = fakeDeps({ participants: [], status: 'ENDED' });
  assert.equal((await handlePresenceEvent({ event: 'participant_left', room: { name: ROOM }, participant: teacher }, ended.deps)).handled, false);
});

test('room finished records absent without pushing permissions', async () => {
  const { deps, calls } = fakeDeps({ participants: [] });
  await handlePresenceEvent({ event: 'room_finished', room: { name: ROOM } }, deps);
  assert.deepEqual(calls.recorded, [false]);
  assert.deepEqual(calls.applied, []);
});

test('webhook path is CSRF-exempt; other API paths are not', () => {
  assert.equal(isCsrfExempt('/api/livekit/webhook'), true);
  assert.equal(isCsrfExempt('/api/livekit/webhook/'), true);
  assert.equal(isCsrfExempt('/api/rooms/ABC/mute'), false);
  // Sanity: the same request without the exemption would be blocked by Origin.
  const headers = new Headers({ origin: 'https://evil.example', host: 'app.example' });
  assert.equal(checkCsrf({ method: 'POST', headers }).ok, false);
});

// —— Webhook route: signature verification ——
const KEY = 'test-key';
const SECRET = 'test-secret-that-is-long-enough-for-hs256-000000';

async function signed(body: string, secret = SECRET) {
  const at = new AccessToken(KEY, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

test('webhook route rejects missing / bad signatures and accepts a valid one', async () => {
  process.env.LIVEKIT_API_KEY = KEY;
  process.env.LIVEKIT_API_SECRET = SECRET;
  const { POST } = await import('../src/app/api/livekit/webhook/route');
  // Not a classroom room name → handled before any DB access.
  const body = JSON.stringify({ event: 'room_started', room: { name: 'not-a-classroom' }, id: 'EV_1', createdAt: '1' });
  const url = 'http://localhost/api/livekit/webhook';
  const type = { 'content-type': 'application/webhook+json' };

  const none = await POST(new Request(url, { method: 'POST', body, headers: type }));
  assert.equal(none.status, 401);

  const wrongKey = await POST(
    new Request(url, { method: 'POST', body, headers: { ...type, authorization: await signed(body, SECRET + 'x') } })
  );
  assert.equal(wrongKey.status, 401);

  const tampered = await POST(
    new Request(url, { method: 'POST', body: body + ' ', headers: { ...type, authorization: await signed(body) } })
  );
  assert.equal(tampered.status, 401);

  const ok = await POST(new Request(url, { method: 'POST', body, headers: { ...type, authorization: await signed(body) } }));
  assert.equal(ok.status, 200);
  const data = (await ok.json()) as { handled: boolean };
  assert.equal(data.handled, false);
});
