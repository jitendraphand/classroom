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

test('concurrent admits never exceed the class-size cap; Redis sets and admittedAt follow', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { ensureRedis, keys } = await import('../../src/lib/redis');
  const { admitWaiting, ClassFullError } = await import('../../src/lib/admission');
  const { updateSchoolSettings } = await import('../../src/lib/schoolSettings');
  await updateSchoolSettings({ maxStudentsPerClass: 5 });
  const { room, cs, students } = await seedRoom({ students: 12, waiting: true });
  const redis = await ensureRedis();
  await redis.sadd(keys.waiting(room.code), ...students.map((s) => s.participant.id));

  const pairs = [];
  for (let i = 0; i < students.length; i += 2) pairs.push(students.slice(i, i + 2).map((s) => s.participant.id));
  const results = await Promise.allSettled(pairs.map((ids) => admitWaiting(room, { ids })));
  const admitted = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
  assert.equal(admitted, 5);
  for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof ClassFullError, String(r.reason));

  const inDb = await prisma.participant.count({ where: { roomId: room.id, status: 'ADMITTED' } });
  assert.equal(inDb, 5);
  assert.equal(await redis.scard(keys.admitted(room.code)), 5);
  assert.equal(await redis.scard(keys.waiting(room.code)), 7);
  const stamped = await prisma.attendanceRecord.count({ where: { classSessionId: cs.id, admittedAt: { not: null } } });
  assert.equal(stamped, 5);
  assert.equal((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status, 'LIVE');
  await updateSchoolSettings({ maxStudentsPerClass: null });
});

test('retention removes only old LEFT student rows', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { pruneOldParticipants } = await import('../../src/lib/retention');
  const { room, students } = await seedRoom({ students: 3 });
  const old = new Date(Date.now() - 40 * 24 * 3600_000);
  await prisma.participant.update({ where: { id: students[0]!.participant.id }, data: { status: 'LEFT', leftAt: old } });
  await prisma.participant.update({ where: { id: students[1]!.participant.id }, data: { status: 'LEFT', leftAt: new Date() } });
  assert.equal(await pruneOldParticipants(new Date(), 30), 1);
  assert.equal(await prisma.participant.count({ where: { roomId: room.id } }), 2);
  assert.equal(await pruneOldParticipants(new Date(), 0), 0);
});

test('direct entry: a student who pressed Leave comes back in; a removed one waits until the teacher admits', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { randomUUID } = await import('node:crypto');
  const { admitIfDirectEntry, admitWaiting } = await import('../../src/lib/admission');
  const { room, cs, students } = await seedRoom({ students: 2 });
  const open = await prisma.room.update({ where: { id: room.id }, data: { waitingRoomOn: false } });
  const newSeat = (s: (typeof students)[number]) =>
    prisma.participant.create({
      data: {
        roomId: room.id,
        displayName: s.student.name,
        role: 'STUDENT',
        status: 'WAITING',
        livekitIdentity: `student_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        sessionToken: randomUUID(),
        studentId: s.student.id,
        classSessionId: cs.id,
        mutedByTeacher: true,
      },
    });

  // Student 0 pressed Leave (no teacher flag), then rejoins.
  const [self, removed] = students;
  await prisma.participant.update({ where: { id: self!.participant.id }, data: { status: 'LEFT', leftAt: new Date() } });
  const back = await newSeat(self!);
  assert.equal(await admitIfDirectEntry(open, back), true);
  assert.equal((await prisma.participant.findUniqueOrThrow({ where: { id: back.id } })).status, 'ADMITTED');

  // Student 1 was removed by the teacher, then rejoins: waits.
  await prisma.participant.update({
    where: { id: removed!.participant.id },
    data: { status: 'LEFT', leftAt: new Date(), removedByTeacher: true },
  });
  const again = await newSeat(removed!);
  assert.equal(await admitIfDirectEntry(open, again), false);
  assert.equal((await prisma.participant.findUniqueOrThrow({ where: { id: again.id } })).status, 'WAITING');

  // The teacher admits them: the removal no longer blocks direct entry.
  assert.equal(await admitWaiting(open, { ids: [again.id] }), 1);
  assert.equal(
    await prisma.participant.count({ where: { roomId: room.id, studentId: removed!.student.id, removedByTeacher: true } }),
    0,
  );
  await prisma.participant.update({ where: { id: again.id }, data: { status: 'LEFT', leftAt: new Date() } });
  const third = await newSeat(removed!);
  assert.equal(await admitIfDirectEntry(open, third), true);

  // Waiting room on: nobody is admitted by direct entry.
  const closed = await prisma.room.update({ where: { id: room.id }, data: { waitingRoomOn: true } });
  await prisma.participant.update({ where: { id: back.id }, data: { status: 'LEFT', leftAt: new Date() } });
  const fourth = await newSeat(self!);
  assert.equal(await admitIfDirectEntry(closed, fourth), false);
});
