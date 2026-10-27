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

test('reports: paged sessions and indexed students give the same counts as before', { skip }, async () => {
  const { prisma } = await import('../../src/lib/db');
  const { attendanceDetail, sessionSummary, studentSummary, summariseByStudent } = await import('../../src/lib/reports');
  const { cs, students } = await seedRoom({ students: 4 });
  await prisma.student.updateMany({ data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
  const at = new Date();
  // Two admitted (one late), one waited only, one never came (record removed).
  await prisma.attendanceRecord.update({ where: { classSessionId_studentId: { classSessionId: cs.id, studentId: students[0]!.student.id } }, data: { admittedAt: at } });
  await prisma.attendanceRecord.update({ where: { classSessionId_studentId: { classSessionId: cs.id, studentId: students[1]!.student.id } }, data: { admittedAt: at, late: true } });
  await prisma.attendanceRecord.delete({ where: { classSessionId_studentId: { classSessionId: cs.id, studentId: students[3]!.student.id } } });

  const f = { from: '2026-10-27', to: '2026-10-27' };
  const sessions = await sessionSummary(f);
  const row = sessions.find((r) => r.sessionId === cs.id)!;
  assert.deepEqual(
    { present: row.present, late: row.late, notAdmitted: row.notAdmitted, absent: row.absent, known: row.knownStudents },
    { present: 1, late: 1, notAdmitted: 1, absent: 1, known: 4 }
  );
  const detail = await attendanceDetail(f);
  assert.equal(detail.length, 4);
  assert.deepEqual(await studentSummary(f), summariseByStudent(detail));
  // Division filter: none of these students are in B.
  assert.equal((await attendanceDetail({ ...f, division: 'B' })).length, 0);
});
