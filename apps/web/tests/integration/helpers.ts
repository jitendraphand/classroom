/**
 * Integration tests run against a real Postgres + Redis:
 *   DATABASE_URL=postgresql://… REDIS_URL=redis://… npm run test:integration
 * (CI starts both as services; see .github/workflows/ci.yml). The schema is
 * applied with `prisma migrate deploy` first. Each test file starts from empty
 * tables and an empty Redis database.
 */
import { randomUUID } from 'node:crypto';

process.env.LIVEKIT_API_KEY ||= 'APItest';
process.env.LIVEKIT_API_SECRET ||= 'test-secret-test-secret-test-secret-00';
// Nothing listens here: LiveKit calls fail fast and are logged, as when the SFU is down.
process.env.LIVEKIT_INTERNAL_URL ||= 'http://127.0.0.1:9';
process.env.NEXTAUTH_SECRET ||= 'integration-secret-integration-secret-0000';

export const integrationReady = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

export async function resetState() {
  const { prisma } = await import('../../src/lib/db');
  const { ensureRedis } = await import('../../src/lib/redis');
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AttendanceRecord", "ClassFeedback", "Message", "Participant", "ClassSession", "Room", "Student", "TeacherAssignment", "Teacher", "SchoolSetting" CASCADE'
  );
  await (await ensureRedis()).flushdb();
}

export async function seedRoom(opts: { students: number; waiting?: boolean }) {
  const { prisma } = await import('../../src/lib/db');
  const teacher = await prisma.teacher.create({
    data: { email: `t-${randomUUID()}@x.test`, name: 'T', passwordHash: 'x', permanentCode: randomUUID().slice(0, 6).toUpperCase() },
  });
  const room = await prisma.room.create({
    data: { code: teacher.permanentCode, name: 'R', teacherId: teacher.id, status: 'LIVE', sessionId: randomUUID().replace(/-/g, '').slice(0, 16) },
  });
  const cs = await prisma.classSession.create({
    data: {
      sessionDate: new Date('2026-10-27T00:00:00Z'),
      teacherId: teacher.id,
      roomId: room.id,
      campus: 'CC',
      grade: '7',
      divisions: ['A'],
      subject: 'Maths',
      adHoc: true,
      startedAt: new Date(),
    },
  });
  await prisma.room.update({ where: { id: room.id }, data: { classSessionId: cs.id } });
  const students = [];
  for (let i = 0; i < opts.students; i++) {
    const st = await prisma.student.create({
      data: { externalId: `S${i}-${randomUUID().slice(0, 6)}`, name: `Student ${i}`, campus: 'CC', grade: '7', division: 'A' },
    });
    const p = await prisma.participant.create({
      data: {
        roomId: room.id,
        displayName: st.name,
        role: 'STUDENT',
        status: opts.waiting ? 'WAITING' : 'ADMITTED',
        livekitIdentity: `student_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        sessionToken: randomUUID(),
        studentId: st.id,
        classSessionId: cs.id,
        mutedByTeacher: true,
      },
    });
    await prisma.attendanceRecord.create({
      data: { classSessionId: cs.id, studentId: st.id, firstJoinedAt: new Date() },
    });
    students.push({ student: st, participant: p });
  }
  return { teacher, room: { ...room, classSessionId: cs.id }, cs, students };
}

export async function disconnect() {
  const { prisma } = await import('../../src/lib/db');
  const { redis } = await import('../../src/lib/redis');
  await prisma.$disconnect();
  redis.disconnect();
}
