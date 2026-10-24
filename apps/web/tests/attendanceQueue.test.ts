import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_EVENT_TRIES,
  applicableEvents,
  decodeEvent,
  encodeEvent,
  eventId,
  notYetApplied,
  flushBatchSize,
  flushIntervalMs,
  groupByIdentity,
  retryable,
  type QueuedConnEvent,
} from '../src/lib/attendanceQueueLogic';
import { applyJoin, applyLeave, type ConnState } from '../src/lib/attendance';

const ev = (kind: 'joined' | 'left', identity: string, sid: string, at: number): QueuedConnEvent => ({ kind, identity, sid, at });

test('attendance queue: events round-trip; junk is skipped', () => {
  const e = ev('joined', 'student_a', 'PA_1', 1000);
  assert.deepEqual(decodeEvent(encodeEvent(e)), { ...e, tries: 0 });
  assert.equal(decodeEvent('nope'), null);
  assert.equal(decodeEvent(JSON.stringify({ kind: 'x', identity: 'a', sid: 'b', at: 1 })), null);
  assert.equal(decodeEvent(JSON.stringify({ kind: 'left', identity: '', sid: 'b', at: 1 })), null);
});

test('attendance queue: grouped per identity in time order, ties keep queue order', () => {
  const g = groupByIdentity([
    ev('left', 'a', 's1', 2000),
    ev('joined', 'b', 's2', 1000),
    ev('joined', 'a', 's1', 1000),
    ev('joined', 'a', 's3', 2000),
  ]);
  assert.deepEqual(g.get('a')!.map((e) => `${e.kind}:${e.sid}`), ['joined:s1', 'left:s1', 'joined:s3']);
  assert.equal(g.get('b')!.length, 1);
});

test('attendance queue: replaying a batch gives the same record (idempotent)', () => {
  const base: ConnState = { connectedMs: 0, connectedSince: null, openSids: [], connections: 0, leftAt: null };
  const evs = [ev('joined', 'a', 's1', 0), ev('left', 'a', 's1', 60_000), ev('joined', 'a', 's2', 70_000)];
  const apply = (s: ConnState) =>
    evs.reduce((acc, e) => (e.kind === 'joined' ? applyJoin(acc, e.sid, new Date(e.at)) : applyLeave(acc, e.sid, new Date(e.at))), s);
  const once = apply(base);
  // a duplicate event is a no-op; a whole replayed batch is filtered by id
  assert.deepEqual(applyJoin(once, 's2', new Date(80_000)), once);
  assert.equal(notYetApplied(evs, new Set(evs.map(eventId))).length, 0);
  assert.equal(notYetApplied(evs, new Set([eventId(evs[0]!)])).length, 2);
  assert.equal(once.connectedMs, 60_000);
  assert.deepEqual(once.openSids, ['s2']);
});

test('attendance queue: joins at/after class end are dropped, leaves kept', () => {
  const end = new Date(10_000);
  const out = applicableEvents([ev('joined', 'a', 's1', 9_000), ev('left', 'a', 's1', 11_000), ev('joined', 'a', 's2', 12_000)], end);
  assert.deepEqual(out.map((e) => e.sid + e.kind), ['s1joined', 's1left']);
  assert.equal(applicableEvents([ev('joined', 'a', 's2', 12_000)], null).length, 1);
});

test('attendance queue: failed events are retried a bounded number of times', () => {
  const { retry, dropped } = retryable([ev('joined', 'a', 's', 1), { ...ev('left', 'a', 's', 2), tries: MAX_EVENT_TRIES - 1 }]);
  assert.equal(retry.length, 1);
  assert.equal(retry[0]!.tries, 1);
  assert.equal(dropped, 1);
});

test('attendance queue: env knobs', () => {
  assert.equal(flushIntervalMs({}), 2000);
  assert.equal(flushIntervalMs({ ATTENDANCE_FLUSH_MS: '5000' }), 5000);
  assert.equal(flushIntervalMs({ ATTENDANCE_FLUSH_MS: '10' }), 2000);
  assert.equal(flushBatchSize({}), 500);
  assert.equal(flushBatchSize({ ATTENDANCE_FLUSH_BATCH: '50' }), 50);
});

test('attendance queue: webhook enqueues, class end flushes before closing', () => {
  const hook = readFileSync(new URL('../src/app/api/livekit/webhook/route.ts', import.meta.url), 'utf8');
  assert.match(hook, /enqueueConnectionEvent\(/);
  assert.doesNotMatch(hook, /recordConnectionEvent\(/);
  const tr = readFileSync(new URL('../src/lib/teacherRoom.ts', import.meta.url), 'utf8');
  assert.ok(tr.indexOf('flushAttendanceQueue({ wait: true })') < tr.indexOf('closeSessionAttendance(classSessionId'));
  const q = readFileSync(new URL('../src/lib/attendanceQueue.ts', import.meta.url), 'utf8');
  // trim only after the batch is written
  assert.ok(q.indexOf('applyConnectionEvents(') < q.indexOf('.ltrim('));
});
