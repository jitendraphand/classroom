/**
 * Pure helpers for the attendance event queue (lib/attendanceQueue.ts),
 * unit-tested in tests/attendanceQueue.test.ts.
 */
export type QueuedConnEvent = {
  kind: 'joined' | 'left';
  identity: string;
  sid: string;
  /** Event time, ms epoch. */
  at: number;
  /** Times this event was put back after a failed write. */
  tries?: number;
};

/** Give up on an event after this many failed writes (logged). */
export const MAX_EVENT_TRIES = 5;

export function encodeEvent(e: QueuedConnEvent): string {
  return JSON.stringify(e);
}

export function decodeEvent(raw: string): QueuedConnEvent | null {
  try {
    const e = JSON.parse(raw) as Partial<QueuedConnEvent>;
    if (!e || (e.kind !== 'joined' && e.kind !== 'left')) return null;
    if (typeof e.identity !== 'string' || !e.identity || typeof e.sid !== 'string' || !e.sid) return null;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return null;
    return { kind: e.kind, identity: e.identity, sid: e.sid, at: e.at, tries: Number(e.tries) || 0 };
  } catch {
    return null;
  }
}

/**
 * Group events per identity, each group in event-time order (queue order
 * breaks ties, so a join and leave in the same second keep arrival order).
 */
export function groupByIdentity(events: QueuedConnEvent[]): Map<string, QueuedConnEvent[]> {
  const out = new Map<string, { e: QueuedConnEvent; i: number }[]>();
  events.forEach((e, i) => {
    const list = out.get(e.identity) ?? [];
    list.push({ e, i });
    out.set(e.identity, list);
  });
  const sorted = new Map<string, QueuedConnEvent[]>();
  for (const [k, list] of out) {
    list.sort((a, b) => a.e.at - b.e.at || a.i - b.i);
    sorted.set(k, list.map((x) => x.e));
  }
  return sorted;
}

/**
 * A join that happened at/after the class end must not reopen an interval the
 * end closed (it would make a student look present at the end). Joins before
 * the end are applied (the end flush runs before the end closes intervals).
 * Leaves are always applied (unknown sids are no-ops).
 */
export function applicableEvents(events: QueuedConnEvent[], sessionEndedAt: Date | null): QueuedConnEvent[] {
  if (!sessionEndedAt) return events;
  const end = sessionEndedAt.getTime();
  return events.filter((e) => e.kind === 'left' || e.at < end);
}

/** Events to put back after a failed write (tries + 1), dropping the ones out of tries. */
export function retryable(events: QueuedConnEvent[]): { retry: QueuedConnEvent[]; dropped: number } {
  const retry: QueuedConnEvent[] = [];
  let dropped = 0;
  for (const e of events) {
    const tries = (e.tries ?? 0) + 1;
    if (tries >= MAX_EVENT_TRIES) dropped++;
    else retry.push({ ...e, tries });
  }
  return { retry, dropped };
}

export function flushIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.ATTENDANCE_FLUSH_MS ?? '', 10);
  return Number.isFinite(n) && n >= 250 ? Math.min(n, 60_000) : 2_000;
}

export function flushBatchSize(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.ATTENDANCE_FLUSH_BATCH ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5_000) : 500;
}

/** Stable id of one event, used to skip events already written on a replay. */
export function eventId(e: QueuedConnEvent): string {
  return `${e.kind}:${e.identity}:${e.sid}:${e.at}`;
}

/** Drop events whose id is already marked applied (replay after a crash). */
export function notYetApplied(events: QueuedConnEvent[], applied: Set<string>): QueuedConnEvent[] {
  return events.filter((e) => !applied.has(eventId(e)));
}
