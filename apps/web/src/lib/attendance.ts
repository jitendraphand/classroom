/**
 * Attendance rules (pure). Connected time is the UNION of a student's media
 * connections: overlapping connections (a duplicate tab, a reconnect whose
 * "left" arrives after the new "joined") are not double counted.
 */
export type ConnState = {
  connectedMs: number;
  connectedSince: Date | null;
  openSids: string[];
  connections: number;
  leftAt: Date | null;
};

export function emptyConn(): ConnState {
  return { connectedMs: 0, connectedSince: null, openSids: [], connections: 0, leftAt: null };
}

function elapsed(from: Date | null, to: Date): number {
  if (!from) return 0;
  return Math.max(0, to.getTime() - from.getTime());
}

/** A LiveKit connection (participant SID) joined. Duplicate joins are ignored. */
export function applyJoin(s: ConnState, sid: string, at: Date): ConnState {
  if (s.openSids.includes(sid)) return s;
  const wasEmpty = s.openSids.length === 0;
  return {
    ...s,
    openSids: [...s.openSids, sid],
    connectedSince: wasEmpty ? at : s.connectedSince,
    connections: s.connections + 1,
  };
}

/** A connection left. Unknown SIDs (already closed, never seen) are ignored. */
export function applyLeave(s: ConnState, sid: string, at: Date): ConnState {
  if (!s.openSids.includes(sid)) return s;
  const openSids = s.openSids.filter((x) => x !== sid);
  if (openSids.length) return { ...s, openSids };
  return {
    ...s,
    openSids: [],
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
    connectedMs: s.connectedMs + elapsed(s.connectedSince, at),
    connectedSince: null,
    leftAt: at,
  };
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
