import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { disconnect, integrationReady, resetState, seedRoom } from './helpers';

const skip = !integrationReady && 'needs DATABASE_URL and REDIS_URL';

before(async () => {
  if (!skip) await resetState();
});
after(async () => {
  if (!skip) await disconnect();
});

test('class end closes every record in one statement, with exact time and closed SIDs', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { closeSessionAttendance } = await import('../../src/lib/attendanceService');
  const { cs, students } = await seedRoom({ students: 3 });
  const end = new Date('2026-10-27T10:00:00.000Z');
  const [open, closed, never] = students.map((s) => s.student.id);
  await prisma.attendanceRecord.update({
    where: { classSessionId_studentId: { classSessionId: cs.id, studentId: open! } },
    data: { connectedMs: 1_000, connectedSince: new Date(end.getTime() - 61_500), openSids: ['PA_a', 'PA_b'], closedSids: ['PA_old'] },
  });
  const earlier = new Date(end.getTime() - 300_000);
  await prisma.attendanceRecord.update({
    where: { classSessionId_studentId: { classSessionId: cs.id, studentId: closed! } },
    data: { connectedMs: 5_000, leftAt: earlier, closedSids: ['PA_c'] },
  });

  const res = await closeSessionAttendance(cs.id, end);
  assert.deepEqual(res, { closed: 1, stamped: 1 });
  const rows = new Map(
    (await prisma.attendanceRecord.findMany({ where: { classSessionId: cs.id } })).map((r) => [r.studentId, r])
  );
  const o = rows.get(open!)!;
  assert.equal(o.connectedMs, 1_000 + 61_500);
  assert.equal(o.connectedSince, null);
  assert.deepEqual(o.openSids, []);
  assert.deepEqual(o.closedSids, ['PA_old', 'PA_a', 'PA_b']);
  assert.equal(o.leftAt?.toISOString(), end.toISOString());
  assert.equal(rows.get(closed!)!.leftAt?.toISOString(), earlier.toISOString(), 'an early leave keeps its time');
  assert.equal(rows.get(never!)!.leftAt?.toISOString(), end.toISOString());
  // Running it again changes nothing.
  assert.deepEqual(await closeSessionAttendance(cs.id, end), { closed: 0, stamped: 0 });
});

test('queue flush applies events once; a replayed in-flight batch and reordered events change nothing', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { ensureRedis } = await import('../../src/lib/redis');
  const { encodeEvent } = await import('../../src/lib/attendanceQueueLogic');
  const { ATTENDANCE_INFLIGHT_KEY, enqueueConnectionEvent, flushAttendanceQueue } = await import('../../src/lib/attendanceQueue');
  const { cs, students } = await seedRoom({ students: 2 });
  const [a, b] = students;
  const t0 = Date.now() - 600_000;
  await enqueueConnectionEvent('joined', a!.participant.livekitIdentity, 'PA_1', new Date(t0));
  await enqueueConnectionEvent('left', a!.participant.livekitIdentity, 'PA_1', new Date(t0 + 120_000));
  // b: the leave reached Redis first and is flushed in an earlier batch.
  await enqueueConnectionEvent('left', b!.participant.livekitIdentity, 'PA_2', new Date(t0 + 30_000));
  await flushAttendanceQueue();
  await enqueueConnectionEvent('joined', b!.participant.livekitIdentity, 'PA_2', new Date(t0));
  await flushAttendanceQueue();

  const read = async (studentId: string) =>
    prisma.attendanceRecord.findUniqueOrThrow({ where: { classSessionId_studentId: { classSessionId: cs.id, studentId } } });
  const ra = await read(a!.student.id);
  assert.equal(ra.connectedMs, 120_000);
  assert.deepEqual(ra.openSids, []);
  const rb = await read(b!.student.id);
  assert.deepEqual(rb.openSids, [], 'no phantom open interval from the late join');
  assert.equal(rb.connectedSince, null);

  // A worker died after writing but before clearing its batch: the next flush replays it.
  const redis = await ensureRedis();
  await redis.rpush(
    ATTENDANCE_INFLIGHT_KEY,
    encodeEvent({ kind: 'joined', identity: a!.participant.livekitIdentity, sid: 'PA_1', at: t0 }),
    encodeEvent({ kind: 'left', identity: a!.participant.livekitIdentity, sid: 'PA_1', at: t0 + 120_000 })
  );
  await flushAttendanceQueue();
  assert.equal(await redis.llen(ATTENDANCE_INFLIGHT_KEY), 0);
  assert.equal((await read(a!.student.id)).connectedMs, 120_000, 'replay does not double count');
});

test('concurrent flushers never lose or double-apply events', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { ensureRedis } = await import('../../src/lib/redis');
  const { ATTENDANCE_QUEUE_KEY, ATTENDANCE_INFLIGHT_KEY, enqueueConnectionEvent, flushAttendanceQueue } = await import('../../src/lib/attendanceQueue');
  const { cs, students } = await seedRoom({ students: 40 });
  const t0 = Date.now() - 600_000;
  for (const [i, s] of students.entries()) {
    await enqueueConnectionEvent('joined', s.participant.livekitIdentity, `PA_${i}`, new Date(t0));
    await enqueueConnectionEvent('left', s.participant.livekitIdentity, `PA_${i}`, new Date(t0 + 10_000 + i));
  }
  process.env.ATTENDANCE_FLUSH_BATCH = '7';
  try {
    await Promise.all([flushAttendanceQueue({ wait: true }), flushAttendanceQueue({ wait: true }), flushAttendanceQueue({ wait: true })]);
  } finally {
    delete process.env.ATTENDANCE_FLUSH_BATCH;
  }
  const redis = await ensureRedis();
  assert.equal(await redis.llen(ATTENDANCE_QUEUE_KEY), 0);
  assert.equal(await redis.llen(ATTENDANCE_INFLIGHT_KEY), 0);
  const rows = await prisma.attendanceRecord.findMany({ where: { classSessionId: cs.id } });
  const byStudent = new Map(rows.map((r) => [r.studentId, r]));
  for (const [i, s] of students.entries()) {
    const r = byStudent.get(s.student.id)!;
    assert.equal(r.connectedMs, 10_000 + i, `student ${i}`);
    assert.equal(r.connections, 1);
  }
});
