import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_EVENT_TRIES,
  applicableEvents,
  decodeEvent,
  encodeEvent,
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
  const base: ConnState = { connectedMs: 0, connectedSince: null, openSids: [], closedSids: [], connections: 0, leftAt: null };
  const evs = [ev('joined', 'a', 's1', 0), ev('left', 'a', 's1', 60_000), ev('joined', 'a', 's2', 70_000)];
  const apply = (s: ConnState) =>
    evs.reduce((acc, e) => (e.kind === 'joined' ? applyJoin(acc, e.sid, new Date(e.at)) : applyLeave(acc, e.sid, new Date(e.at))), s);
  const once = apply(base);
  // a duplicate event is a no-op, and so is a whole replayed batch: the closed
  // s1 is remembered, so its replayed join cannot reopen (and recount) it.
  assert.deepEqual(applyJoin(once, 's2', new Date(80_000)), once);
  assert.deepEqual(apply(once), once);
  assert.equal(once.connectedMs, 60_000);
  assert.deepEqual(once.openSids, ['s2']);
  assert.deepEqual(once.closedSids, ['s1']);
});

test('attendance: a leave that arrives before its join leaves no phantom open interval', () => {
  const base: ConnState = { connectedMs: 0, connectedSince: null, openSids: [], closedSids: [], connections: 0, leftAt: null };
  // Two workers pushed the events in reverse order, into different batches.
  const afterLeave = applyLeave(base, 'PA_x', new Date(5_000));
  assert.deepEqual(afterLeave.closedSids, ['PA_x']);
  const afterJoin = applyJoin(afterLeave, 'PA_x', new Date(1_000));
  assert.deepEqual(afterJoin.openSids, []);
  assert.equal(afterJoin.connectedSince, null);
  // A later, different connection still counts normally.
  const next = applyLeave(applyJoin(afterJoin, 'PA_y', new Date(10_000)), 'PA_y', new Date(70_000));
  assert.equal(next.connectedMs, 60_000);
});

test('attendance: closed SIDs are bounded', async () => {
  const { MAX_CLOSED_SIDS } = await import('../src/lib/attendance');
  let s: ConnState = { connectedMs: 0, connectedSince: null, openSids: [], closedSids: [], connections: 0, leftAt: null };
  for (let i = 0; i < MAX_CLOSED_SIDS + 10; i++) s = applyLeave(applyJoin(s, `s${i}`, new Date(i * 10)), `s${i}`, new Date(i * 10 + 5));
  assert.equal(s.closedSids.length, MAX_CLOSED_SIDS);
  assert.equal(s.closedSids.at(-1), `s${MAX_CLOSED_SIDS + 9}`);
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
  assert.equal(flushBatchSize({ ATTENDANCE_FLUSH_BATCH: '99999' }), 2000);
});

test('attendance queue: webhook enqueues, class end flushes before closing', () => {
  const hook = readFileSync(new URL('../src/app/api/livekit/webhook/route.ts', import.meta.url), 'utf8');
  assert.match(hook, /enqueueConnectionEvent\(/);
  assert.doesNotMatch(hook, /recordConnectionEvent\(/);
  const tr = readFileSync(new URL('../src/lib/teacherRoom.ts', import.meta.url), 'utf8');
  assert.ok(tr.indexOf('flushAttendanceQueue({ wait: true })') < tr.indexOf('closeSessionAttendance(classSessionId'));
});

test('attendance queue: claim and finish only for the lock holder', async () => {
  const { CLAIM_LUA, FINISH_LUA } = await import('../src/lib/attendanceQueue');
  // The batch is moved to the in-flight list (never just trimmed), a leftover
  // in-flight batch is taken first, and both scripts check the lock token.
  assert.match(CLAIM_LUA, /GET', KEYS\[3\]\) ~= ARGV\[1\]/);
  assert.match(CLAIM_LUA, /RPUSH', KEYS\[2\]/);
  assert.ok(CLAIM_LUA.indexOf("LRANGE', KEYS[2]") < CLAIM_LUA.indexOf("LRANGE', KEYS[1]"));
  assert.match(FINISH_LUA, /GET', KEYS\[2\]\) ~= ARGV\[1\]/);
});
