/**
 * Attendance join/leave events from the LiveKit webhook go onto a Redis list
 * and are written in batches every ATTENDANCE_FLUSH_MS by one worker (leader
 * lock). At 1,500 students the old per-event interactive transaction (row lock
 * per webhook) exhausted the pool ("Transaction already closed").
 *
 * No event is lost: events are read with LRANGE and only trimmed after the
 * batch is written; failed groups go back on the list (up to MAX_EVENT_TRIES).
 * A crash mid-flush replays the batch, which is safe because joins/leaves are
 * idempotent per SID. When Redis is down the webhook writes directly.
 */
import { prisma } from './db';
import { ensureRedis } from './redis';
import { acquireLock, releaseLock } from './leaderLock';
import { applyConnectionEvents, recordConnectionEvent } from './attendanceService';
import {
  applicableEvents,
  decodeEvent,
  encodeEvent,
  eventId,
  notYetApplied,
  flushBatchSize,
  flushIntervalMs,
  groupByIdentity,
  retryable,
  type QueuedConnEvent,
} from './attendanceQueueLogic';

export const ATTENDANCE_QUEUE_KEY = 'att:events';
/** Ids of events already written (an hour), so a replayed batch is skipped. */
const APPLIED_KEY = 'att:applied';
const LOCK_KEY = 'lock:attendance-flush';
const LOCK_TTL_S = 30;
const GROUP_CONCURRENCY = 6;
/** One flush stops pulling new batches after this long (the next tick continues). */
const FLUSH_BUDGET_MS = 10_000;

/** Webhook entry: queue the event (fast), or write it directly if Redis is down. */
export async function enqueueConnectionEvent(kind: 'joined' | 'left', identity: string, sid: string, at: Date) {
  startAttendanceFlusher();
  try {
    const redis = await ensureRedis();
    await redis.rpush(ATTENDANCE_QUEUE_KEY, encodeEvent({ kind, identity, sid, at: at.getTime() }));
  } catch (e) {
    console.warn('[attendance] queue unavailable, writing directly', e instanceof Error ? e.message : e);
    await recordConnectionEvent(kind, identity, sid, at);
  }
}

async function runPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    })
  );
}

/** Write one batch. Returns the number of raw entries consumed (0 = queue empty). */
async function flushBatch(): Promise<number> {
  const redis = await ensureRedis();
  const raw = await redis.lrange(ATTENDANCE_QUEUE_KEY, 0, flushBatchSize() - 1);
  if (!raw.length) return 0;
  const events = raw.map(decodeEvent).filter((e): e is QueuedConnEvent => !!e);
  const groups = groupByIdentity(events);
  const parts = groups.size
    ? await prisma.participant.findMany({
        where: { livekitIdentity: { in: [...groups.keys()] } },
        select: { livekitIdentity: true, studentId: true, classSessionId: true, role: true },
      })
    : [];
  const sessionIds = [...new Set(parts.map((p) => p.classSessionId).filter((x): x is string => !!x))];
  const sessions = sessionIds.length
    ? await prisma.classSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true, endedAt: true } })
    : [];
  const endedAt = new Map(sessions.map((s) => [s.id, s.endedAt]));
  const byIdentity = new Map(parts.map((p) => [p.livekitIdentity, p]));

  // Same student can have several identities (rejoin): merge per record so one
  // lock covers them, keeping time order.
  const perRecord = new Map<string, { cs: string; st: string; events: QueuedConnEvent[] }>();
  for (const [identity, list] of groups) {
    const p = byIdentity.get(identity);
    if (!p || p.role !== 'STUDENT' || !p.studentId || !p.classSessionId) continue;
    const k = `${p.classSessionId}:${p.studentId}`;
    const g = perRecord.get(k) ?? { cs: p.classSessionId, st: p.studentId, events: [] };
    g.events.push(...list);
    perRecord.set(k, g);
  }

  const allIds = events.map(eventId);
  const flags = allIds.length ? await redis.smismember(APPLIED_KEY, ...allIds) : [];
  const applied = new Set(allIds.filter((_, i) => flags[i] === 1));

  const failed: QueuedConnEvent[] = [];
  const done: string[] = [];
  await runPool([...perRecord.values()], GROUP_CONCURRENCY, async (g) => {
    const evs = applicableEvents(
      notYetApplied([...g.events].sort((a, b) => a.at - b.at), applied),
      endedAt.get(g.cs) ?? null
    );
    try {
      await applyConnectionEvents(
        g.cs,
        g.st,
        evs.map((e) => ({ kind: e.kind, sid: e.sid, at: new Date(e.at) })),
        endedAt.get(g.cs) ?? null
      );
      done.push(...g.events.map(eventId));
    } catch (e) {
      console.error('[attendance] batch write failed', e instanceof Error ? e.message : e);
      failed.push(...g.events);
    }
  });

  const { retry, dropped } = retryable(failed);
  if (dropped) console.error(`[attendance] dropped ${dropped} event(s) after repeated write failures`);
  const m = redis.multi();
  if (done.length) m.sadd(APPLIED_KEY, ...done).expire(APPLIED_KEY, 3600);
  m.ltrim(ATTENDANCE_QUEUE_KEY, raw.length, -1);
  if (retry.length) m.rpush(ATTENDANCE_QUEUE_KEY, ...retry.map(encodeEvent));
  await m.exec();
  return raw.length;
}

/**
 * Drain the queue under the leader lock. `wait` (class end) waits for another
 * worker's flush to finish so the end sees every queued leave.
 */
export async function flushAttendanceQueue(opts: { wait?: boolean } = {}): Promise<void> {
  let token = await acquireLock(LOCK_KEY, LOCK_TTL_S);
  const deadline = Date.now() + 8_000;
  while (!token && opts.wait && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    token = await acquireLock(LOCK_KEY, LOCK_TTL_S);
  }
  if (!token) return;
  try {
    const start = Date.now();
    while ((await flushBatch()) > 0 && (opts.wait || Date.now() - start < FLUSH_BUDGET_MS)) {
      /* keep draining */
    }
  } catch (e) {
    console.error('[attendance] flush', e instanceof Error ? e.message : e);
  } finally {
    await releaseLock(LOCK_KEY, token);
  }
}

export function startAttendanceFlusher() {
  const g = globalThis as unknown as { __attFlusher?: NodeJS.Timeout };
  if (g.__attFlusher) return;
  const ms = flushIntervalMs();
  let busy = false;
  g.__attFlusher = setInterval(() => {
    if (busy) return;
    busy = true;
    void flushAttendanceQueue().finally(() => {
      busy = false;
    });
  }, ms + Math.floor(Math.random() * 250));
  g.__attFlusher.unref?.();
}
