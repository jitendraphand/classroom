import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TrackSource } from 'livekit-server-sdk';
import { idlePending, MIC_IDLE_MS, rebuildForLimit, studentSetMic, syncPending, teacherSetMic, type MicBook } from '../src/lib/micSlots';
import { withPermissionRetry } from '../src/lib/livekit';
import { micIsOn } from '../src/lib/micSlotService';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const T = (id: string) => ({ id, source: 'teacher' as const });

test('leaving frees the slot and promotes the next teacher-approved waiter', () => {
  let book: MicBook = { open: [], queue: [] };
  book = teacherSetMic(book, 'a', false, 1);
  const b = teacherSetMic(book, 'b', false, 1);
  assert.equal(b.waiting, true);
  const out = studentSetMic(b, 'a', false, 1) as MicBook & { promoted?: string | null };
  assert.deepEqual(out.open, ['b']);
  assert.equal(out.promoted, 'b');
  assert.deepEqual(out.queue, []);
});

test('limit turned on: earliest keep the floor, the most recent are muted and queued first', () => {
  const r = rebuildForLimit({ open: [], queue: [] }, ['s1', 's2', 's3'], ['s1', 's2', 's3', 's4'], 1);
  assert.deepEqual(r.next.open, ['s1']);
  assert.deepEqual(r.mute, ['s2', 's3']);
  assert.deepEqual(r.next.queue, [T('s2'), T('s3')]);
  assert.deepEqual(r.unmute, []);
});

test('limit lowered: slot holders keep their order, the rest go to the front of the queue', () => {
  const book: MicBook = { open: ['b', 'a', 'c'], queue: [T('d'), { id: 'e', source: 'student' }] };
  const r = rebuildForLimit(book, ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(r.next.open, ['b', 'a']);
  assert.deepEqual(r.mute, ['c']);
  assert.deepEqual(r.next.queue, [T('c'), T('d'), { id: 'e', source: 'student' }]);
});

test('limit raised: teacher-approved waiters are promoted; students who only asked are not', () => {
  const book: MicBook = { open: ['a'], queue: [{ id: 's', source: 'student' }, T('b'), T('c')] };
  const r = rebuildForLimit(book, ['a'], ['a', 's', 'b', 'c'], 2);
  assert.deepEqual(r.next.open, ['a', 'b']);
  assert.deepEqual(r.unmute, ['b']);
  assert.deepEqual(r.next.queue, [{ id: 's', source: 'student' }, T('c')]);
});

test('limit set to 0: book cleared, approved waiters unmuted, departed students dropped', () => {
  const book: MicBook = { open: ['a'], queue: [T('b'), T('gone'), { id: 's', source: 'student' }] };
  const r = rebuildForLimit(book, ['a'], ['a', 'b', 's'], 0);
  assert.deepEqual(r.next, { open: [], queue: [] });
  assert.deepEqual(r.unmute, ['b']);
  assert.deepEqual(r.mute, []);
});

test('unmuted students no longer in the class are ignored by the recount', () => {
  const r = rebuildForLimit({ open: ['x', 'a'], queue: [] }, ['a'], ['a'], 1);
  assert.deepEqual(r.next.open, ['a']);
});

test('pending grant times: new slots start now, kept slots keep theirs, confirmed slots stay confirmed', () => {
  const prev: MicBook = { open: ['a', 'b'], queue: [], pending: { a: 100 } };
  assert.deepEqual(syncPending(prev, { open: ['a', 'b', 'c'], queue: [] }, 500), { a: 100, c: 500 });
  // The sweep confirms a by passing pending explicitly.
  assert.deepEqual(syncPending(prev, { open: ['a', 'b'], queue: [], pending: {} }, 500), {});
  assert.deepEqual(syncPending(prev, { open: ['b'], queue: [] }, 500), {});
});

test('idle slots: pending for MIC_IDLE_MS or longer', () => {
  const book: MicBook = { open: ['a', 'b'], queue: [], pending: { a: 0, b: 30_000, gone: 0 } };
  assert.deepEqual(idlePending(book, MIC_IDLE_MS), ['a']);
  assert.deepEqual(idlePending(book, MIC_IDLE_MS + 30_000).sort(), ['a', 'b']);
  assert.equal(MIC_IDLE_MS, 60_000);
});

test('mic on = an unmuted microphone track', () => {
  assert.equal(micIsOn([{ source: TrackSource.MICROPHONE, muted: false }]), true);
  assert.equal(micIsOn([{ source: TrackSource.MICROPHONE, muted: true }]), false);
  assert.equal(micIsOn([{ source: TrackSource.CAMERA, muted: false }]), false);
  assert.equal(micIsOn(undefined), false);
});

test('LiveKit permission calls retry briefly, treat "not found" as final', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  assert.equal(await withPermissionRetry(async () => (++n < 3 ? Promise.reject(new Error('timeout')) : 'ok'), [1, 2], sleep), 'ok');
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [1, 2]);
  assert.equal(await withPermissionRetry(async () => Promise.reject(new Error('participant not found')), [1], sleep), 'gone');
  await assert.rejects(withPermissionRetry(async () => Promise.reject(new Error('boom')), [1], sleep), /boom/);
});

test('wired: leave, disconnect, limit change, idle sweep, awaited mutes, labels, hint', () => {
  assert.match(src('app/api/rooms/[code]/leave/route.ts'), /releaseMicSlot\(room, target\.id, \{ mute: true \}\)/);
  assert.match(src('app/api/livekit/webhook/route.ts'), /scheduleDisconnectRelease\(room\.code, room\.sessionId, c\.identity\)/);
  assert.match(src('app/api/admin/settings/route.ts'), /reconcileMicLimit\(saved\.maxOpenStudentMics\)/);
  assert.match(src('instrumentation.ts'), /startMicIdleSweeper\(\)/);
  for (const f of ['app/api/rooms/[code]/mute/route.ts', 'app/api/rooms/[code]/mic/route.ts']) {
    assert.doesNotMatch(src(f), /void set(Many|Participant)/, f);
  }
  for (const f of ['components/classroom/Controls.tsx', 'components/classroom/ClassroomRoom.tsx', 'components/classroom/TeacherShareHud.tsx', 'components/classroom/MeetingBar.tsx']) {
    assert.doesNotMatch(src(f), /Unmute all/, f);
    assert.match(src(f), /Allow all to unmute/, f);
  }
  assert.match(src('components/classroom/ClassroomRoom.tsx'), /const askByHand = !isTeacher && effectiveMuted;/);
});
