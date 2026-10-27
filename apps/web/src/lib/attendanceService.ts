import type { AttendanceRecord, ClassSession, Prisma } from '@prisma/client';
import { prisma } from './db';
import { MAX_CLOSED_SIDS, applyJoin, applyLeave, closeAll, isLate, lateThreshold, settleAfterEnd, type ConnState } from './attendance';
import { lateGraceMinutes } from './schoolConfig';

function toConn(r: AttendanceRecord): ConnState {
  return {
    connectedMs: r.connectedMs,
    connectedSince: r.connectedSince,
    openSids: r.openSids ?? [],
    closedSids: r.closedSids ?? [],
    connections: r.connections,
    leftAt: r.leftAt,
  };
}

function connData(s: ConnState) {
  return {
    connectedMs: Math.min(2_000_000_000, Math.round(s.connectedMs)),
    connectedSince: s.connectedSince,
    openSids: s.openSids,
    closedSids: s.closedSids,
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

/**
 * Admit → admittedAt (first admission only). One update per class session
 * (normally exactly one), not one per student: "Admit all" for a big class
 * used to be thousands of sequential queries.
 */
export async function markAdmitted(participantIds: string[], at = new Date()) {
  if (!participantIds.length) return;
  const parts = await prisma.participant.findMany({
    where: { id: { in: participantIds }, studentId: { not: null }, classSessionId: { not: null } },
    select: { studentId: true, classSessionId: true },
  });
  const bySession = new Map<string, string[]>();
  for (const p of parts) {
    const list = bySession.get(p.classSessionId!) ?? [];
    list.push(p.studentId!);
    bySession.set(p.classSessionId!, list);
  }
  for (const [classSessionId, studentIds] of bySession) {
    await prisma.attendanceRecord.updateMany({
      where: { classSessionId, studentId: { in: studentIds }, admittedAt: null },
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

/**
 * Apply several queued connection events for one student in one short locked
 * transaction (lib/attendanceQueue.ts). Events must be in time order; joins
 * and leaves are idempotent per SID, so replaying a batch is safe.
 */
export async function applyConnectionEvents(
  classSessionId: string,
  studentId: string,
  events: { kind: 'joined' | 'left'; sid: string; at: Date }[],
  sessionEndedAt: Date | null = null
) {
  if (!events.length) return;
  await withLockedRecord(classSessionId, studentId, (r) => {
    let s = toConn(r);
    for (const e of events) s = e.kind === 'joined' ? applyJoin(s, e.sid, e.at) : applyLeave(s, e.sid, e.at);
    // Flushed after the class ended (e.g. the end-time flush could not get the
    // lock): never leave the record open; close it at the end time.
    return settleAfterEnd(s, sessionEndedAt);
  });
}

/** Explicit leave / removal of one participant. */
export async function closeParticipantAttendance(participant: { studentId: string | null; classSessionId: string | null }, at = new Date()) {
  if (!participant.studentId || !participant.classSessionId) return;
  await withLockedRecord(participant.classSessionId, participant.studentId, (r) => closeAll(toConn(r), at));
}

/**
 * Class ended: close every open interval, and give every record still without
 * a leave time the end time.
 *
 * Two set-based statements for the whole class (it used to be one locked
 * transaction per student, inside the End-class request). The row locks the
 * UPDATE takes serialise it with a concurrent queue flush (withLockedRecord):
 * whichever runs second sees the other's result, and a join flushed after the
 * end is settled by settleAfterEnd.
 *
 * Trial 2 left 106 rows with leftAt = null: only rows with an open interval
 * were closed here, so students who arrived (lobby / admitted) but never had a
 * LiveKit connection recorded were skipped. Returns counts.
 */
export async function closeSessionAttendance(classSessionId: string, at = new Date()) {
  const atMs = at.getTime();
  // Timestamps are stored as UTC wall-clock `timestamp(3)` (Prisma), so the end
  // time is built the same way, independent of the session TimeZone.
  const closed = await prisma.$executeRaw`
    UPDATE "AttendanceRecord" SET
      "connectedMs" = LEAST(
        2000000000::bigint,
        "connectedMs"::bigint + COALESCE(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
          (to_timestamp(${atMs}::double precision / 1000) AT TIME ZONE 'UTC') - "connectedSince"
        )) * 1000))::bigint, 0)
      )::int,
      "connectedSince" = NULL,
      "closedSids" = (COALESCE("closedSids", ARRAY[]::TEXT[]) || COALESCE("openSids", ARRAY[]::TEXT[]))[
        GREATEST(1, cardinality(COALESCE("closedSids", ARRAY[]::TEXT[]) || COALESCE("openSids", ARRAY[]::TEXT[])) - ${MAX_CLOSED_SIDS - 1}):
      ],
      "openSids" = ARRAY[]::TEXT[],
      "leftAt" = to_timestamp(${atMs}::double precision / 1000) AT TIME ZONE 'UTC',
      "updatedAt" = to_timestamp(${atMs}::double precision / 1000) AT TIME ZONE 'UTC'
    WHERE "classSessionId" = ${classSessionId}
      AND ("connectedSince" IS NOT NULL OR cardinality(COALESCE("openSids", ARRAY[]::TEXT[])) > 0)`;
  // No interval open and no leave time: nothing to add to connectedMs, just
  // stamp it. NULL-safe: rows written before openSids had a default hold NULL.
  const stamped = await prisma.$executeRaw`
    UPDATE "AttendanceRecord" SET
      "leftAt" = to_timestamp(${atMs}::double precision / 1000) AT TIME ZONE 'UTC',
      "updatedAt" = to_timestamp(${atMs}::double precision / 1000) AT TIME ZONE 'UTC'
    WHERE "classSessionId" = ${classSessionId}
      AND "leftAt" IS NULL AND "connectedSince" IS NULL
      AND cardinality(COALESCE("openSids", ARRAY[]::TEXT[])) = 0`;
  return { closed, stamped };
}
