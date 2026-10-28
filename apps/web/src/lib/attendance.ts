/**
 * Attendance rules (pure). Connected time is the UNION of a student's media
 * connections: overlapping connections (a duplicate tab, a reconnect whose
 * "left" arrives after the new "joined") are not double counted.
 *
 * Every rule is idempotent per LiveKit participant SID, whatever the order the
 * events arrive in: a SID that has been closed (or whose "left" arrived before
 * its "joined") is remembered in `closedSids`, so a replayed batch or a
 * reordered webhook can never reopen an interval or count it twice.
 */
export type ConnState = {
  connectedMs: number;
  connectedSince: Date | null;
  openSids: string[];
  /** Most recent closed / tombstoned SIDs (MAX_CLOSED_SIDS). */
  closedSids: string[];
  connections: number;
  leftAt: Date | null;
};

/** How many closed SIDs a record remembers (a reconnect storm still fits). */
export const MAX_CLOSED_SIDS = 64;

export function emptyConn(): ConnState {
  return { connectedMs: 0, connectedSince: null, openSids: [], closedSids: [], connections: 0, leftAt: null };
}

function elapsed(from: Date | null, to: Date): number {
  if (!from) return 0;
  return Math.max(0, to.getTime() - from.getTime());
}

function remember(closed: string[], sids: string[]): string[] {
  const next = [...closed.filter((x) => !sids.includes(x)), ...sids];
  return next.length > MAX_CLOSED_SIDS ? next.slice(next.length - MAX_CLOSED_SIDS) : next;
}

/** A LiveKit connection (participant SID) joined. Duplicate, replayed or late (already closed) joins are ignored. */
export function applyJoin(s: ConnState, sid: string, at: Date): ConnState {
  if (s.openSids.includes(sid) || s.closedSids.includes(sid)) return s;
  const wasEmpty = s.openSids.length === 0;
  return {
    ...s,
    openSids: [...s.openSids, sid],
    connectedSince: wasEmpty ? at : s.connectedSince,
    connections: s.connections + 1,
  };
}

/**
 * A connection left. A SID that is not open is remembered as closed (its
 * "joined" may still be on its way, and must then be ignored) and changes
 * nothing else.
 */
export function applyLeave(s: ConnState, sid: string, at: Date): ConnState {
  if (!s.openSids.includes(sid)) {
    return s.closedSids.includes(sid) ? s : { ...s, closedSids: remember(s.closedSids, [sid]) };
  }
  const openSids = s.openSids.filter((x) => x !== sid);
  const closedSids = remember(s.closedSids, [sid]);
  if (openSids.length) return { ...s, openSids, closedSids };
  return {
    ...s,
    openSids: [],
    closedSids,
    connectedMs: s.connectedMs + elapsed(s.connectedSince, at),
    connectedSince: null,
    leftAt: at,
  };
}

/** Explicit leave / class end: close every open connection. */
export function closeAll(s: ConnState, at: Date): ConnState {
  if (!s.openSids.length && !s.connectedSince) return { ...s, leftAt: s.leftAt ?? at };
  return {
    ...s,
    openSids: [],
    closedSids: remember(s.closedSids, s.openSids),
    connectedMs: s.connectedMs + elapsed(s.connectedSince, at),
    connectedSince: null,
    leftAt: at,
  };
}

/**
 * After a class has ended, a record must not stay open or without a leave
 * time: a late-flushed join (queue drained after the end close) or a lost
 * participant_left would otherwise leave it open forever. Closes at the end.
 */
export function settleAfterEnd(s: ConnState, endedAt: Date | null): ConnState {
  if (!endedAt) return s;
  if (s.openSids.length || s.connectedSince || !s.leftAt) return closeAll(s, endedAt);
  return s;
}

/** Total including a still-open interval. */
export function totalConnectedMs(s: Pick<ConnState, 'connectedMs' | 'connectedSince'>, now: Date): number {
  return s.connectedMs + elapsed(s.connectedSince, now);
}

/**
 * When lateness starts counting: scheduled classes use the later of the
 * scheduled start and the moment the teacher opened the class (students are
 * not late because the teacher was); ad-hoc classes use the actual start.
 */
export function lateThreshold(
  cs: { adHoc: boolean; scheduledStart: Date | null; startedAt: Date | null },
  graceMinutes: number
): Date | null {
  const base = cs.adHoc
    ? cs.startedAt
    : cs.scheduledStart && cs.startedAt
      ? new Date(Math.max(cs.scheduledStart.getTime(), cs.startedAt.getTime()))
      : cs.scheduledStart ?? cs.startedAt;
  return base ? new Date(base.getTime() + graceMinutes * 60_000) : null;
}

export function isLate(
  firstJoinedAt: Date,
  cs: { adHoc: boolean; scheduledStart: Date | null; startedAt: Date | null },
  graceMinutes: number
): boolean {
  const t = lateThreshold(cs, graceMinutes);
  return !!t && firstJoinedAt.getTime() > t.getTime();
}

export type AttendanceStatus = 'present' | 'late' | 'not_admitted' | 'absent';

/** present / late = admitted into the class; not_admitted = waited only; absent = never came. */
export function attendanceStatus(
  r: { admittedAt: Date | null; late: boolean; connectedMs?: number } | null | undefined
): AttendanceStatus {
  if (!r) return 'absent';
  if (!r.admittedAt) return 'not_admitted';
  return r.late ? 'late' : 'present';
}

/**
 * One row per student. A second device or a duplicate webhook must not
 * raise the present / late / waited totals.
 */
export function tallyAttendance(
  rows: { studentId: string; status: AttendanceStatus }[]
): { present: number; late: number; notAdmitted: number } {
  const seen = new Set<string>();
  const counts = { present: 0, late: 0, notAdmitted: 0 };
  for (const r of rows) {
    if (!r.studentId || seen.has(r.studentId)) continue;
    seen.add(r.studentId);
    if (r.status === 'present') counts.present++;
    else if (r.status === 'late') counts.late++;
    else if (r.status === 'not_admitted') counts.notAdmitted++;
  }
  return counts;
}

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  not_admitted: 'Waited, not admitted',
  absent: 'Absent',
};

export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
