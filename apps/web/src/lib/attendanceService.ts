import type { AttendanceRecord, ClassSession, Prisma } from '@prisma/client';
import { prisma } from './db';
import { applyJoin, applyLeave, closeAll, isLate, lateThreshold, type ConnState } from './attendance';
import { lateGraceMinutes } from './schoolConfig';

function toConn(r: AttendanceRecord): ConnState {
  return {
    connectedMs: r.connectedMs,
    connectedSince: r.connectedSince,
    openSids: r.openSids,
    connections: r.connections,
    leftAt: r.leftAt,
  };
}

function connData(s: ConnState) {
  return {
    connectedMs: Math.min(2_000_000_000, Math.round(s.connectedMs)),
    connectedSince: s.connectedSince,
    openSids: s.openSids,
    connections: s.connections,
    leftAt: s.leftAt,
  };
}

/** First arrival of a student for a class session (idempotent; keeps the first time). */
export async function recordArrival(cs: ClassSession, studentId: string, at = new Date()) {
  const existing = await prisma.attendanceRecord.findUnique({
    where: { classSessionId_studentId: { classSessionId: cs.id, studentId } },
  });
  if (existing) return existing;
  try {
    return await prisma.attendanceRecord.create({
      data: {
        classSessionId: cs.id,
        studentId,
        firstJoinedAt: at,
        late: isLate(at, cs, lateGraceMinutes()),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return prisma.attendanceRecord.findUniqueOrThrow({
        where: { classSessionId_studentId: { classSessionId: cs.id, studentId } },
      });
    }
    throw e;
  }
}

/** Teacher opened the class: arrivals before (start + grace) are not late. */
export async function refreshLateFlags(cs: ClassSession) {
  const t = lateThreshold(cs, lateGraceMinutes());
  if (!t) return;
  await prisma.attendanceRecord.updateMany({
    where: { classSessionId: cs.id, late: true, firstJoinedAt: { lte: t } },
    data: { late: false },
  });
}

/** Admit → admittedAt (first admission only). */
export async function markAdmitted(participantIds: string[], at = new Date()) {
  if (!participantIds.length) return;
  const parts = await prisma.participant.findMany({
    where: { id: { in: participantIds }, studentId: { not: null }, classSessionId: { not: null } },
    select: { studentId: true, classSessionId: true },
  });
  for (const p of parts) {
    await prisma.attendanceRecord.updateMany({
      where: { classSessionId: p.classSessionId!, studentId: p.studentId!, admittedAt: null },
      data: { admittedAt: at },
    });
  }
}

/** Run a read-modify-write on one record under a row lock. */
async function withLockedRecord(
  classSessionId: string,
  studentId: string,
  fn: (r: AttendanceRecord) => ConnState | null
) {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AttendanceRecord"
      WHERE "classSessionId" = ${classSessionId} AND "studentId" = ${studentId}
      FOR UPDATE`;
    if (!rows.length) return;
    const r = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: rows[0]!.id } });
    const next = fn(r);
    if (next) await tx.attendanceRecord.update({ where: { id: r.id }, data: connData(next) });
  });
}

/** LiveKit webhook participant_joined / participant_left for a student identity. */
export async function recordConnectionEvent(
  kind: 'joined' | 'left',
  identity: string,
  sid: string,
  at: Date
): Promise<boolean> {
  const p = await prisma.participant.findUnique({
    where: { livekitIdentity: identity },
    select: { studentId: true, classSessionId: true, role: true },
  });
  if (!p || p.role !== 'STUDENT' || !p.studentId || !p.classSessionId) return false;
  await withLockedRecord(p.classSessionId, p.studentId, (r) =>
    kind === 'joined' ? applyJoin(toConn(r), sid, at) : applyLeave(toConn(r), sid, at)
  );
  return true;
}

/** Explicit leave / removal of one participant. */
export async function closeParticipantAttendance(participant: { studentId: string | null; classSessionId: string | null }, at = new Date()) {
  if (!participant.studentId || !participant.classSessionId) return;
  await withLockedRecord(participant.classSessionId, participant.studentId, (r) => closeAll(toConn(r), at));
}

/** Class ended: close every open interval. */
export async function closeSessionAttendance(classSessionId: string, at = new Date()) {
  const open = await prisma.attendanceRecord.findMany({
    where: { classSessionId, OR: [{ connectedSince: { not: null } }, { openSids: { isEmpty: false } }] },
    select: { studentId: true },
  });
  for (const r of open) {
    await withLockedRecord(classSessionId, r.studentId, (rec) => closeAll(toConn(rec), at));
  }
}
