/**
 * Attendance join/leave events from the LiveKit webhook go onto a Redis list
 * (pushed by the webhook handler before it answers LiveKit, so an acknowledged
 * event is durable) and are written in batches every ATTENDANCE_FLUSH_MS by
 * one worker (leader lock). At 1,500 students the old per-event interactive
 * transaction (row lock per webhook) exhausted the pool ("Transaction already
 * closed").
 *
 * No event is lost and none is applied twice in effect:
 * - A batch is claimed atomically (Lua): moved from the queue to an in-flight
 *   list, only while this worker still holds the lock (renewed per batch).
 * - The in-flight list is cleared only after the batch is written, again only
 *   by the lock holder. A worker that crashed or lost its lock leaves it for
 *   the next leader, which processes it first.
 * - Re-applying a batch is harmless: joins/leaves are idempotent per SID,
 *   whatever the order (lib/attendance.ts closedSids).
 * - Failed groups go back on the queue (up to MAX_EVENT_TRIES).
 * When Redis is down the webhook writes directly.
 */
import { prisma } from './db';
import { ensureRedis } from './redis';
import { acquireLock, releaseLock } from './leaderLock';
import { applyConnectionEvents, recordConnectionEvent } from './attendanceService';
import {
  applicableEvents,
  decodeEvent,
  encodeEvent,
  flushBatchSize,
  flushIntervalMs,
  groupByIdentity,
  retryable,
  type QueuedConnEvent,
} from './attendanceQueueLogic';

export const ATTENDANCE_QUEUE_KEY = 'att:events';
/** The batch being written by the lock holder (or left behind by one that died). */
export const ATTENDANCE_INFLIGHT_KEY = 'att:inflight';
const LOCK_KEY = 'lock:attendance-flush';
const LOCK_TTL_MS = 30_000;
const GROUP_CONCURRENCY = 6;
/** One flush stops pulling new batches after this long (the next tick continues). */
const FLUSH_BUDGET_MS = 10_000;
/** Class end waits at most this long for the queue to drain (later events are settled at the end time). */
const END_FLUSH_BUDGET_MS = 15_000;

/**
 * KEYS: queue, inflight, lock. ARGV: token, batch size, lock ttl ms.
 * Returns the batch to write (a leftover in-flight batch first), [] when the
 * queue is empty, or nil when this worker no longer holds the lock.
 */
export const CLAIM_LUA = `
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return false end
redis.call('PEXPIRE', KEYS[3], ARGV[3])
local cur = redis.call('LRANGE', KEYS[2], 0, -1)
if #cur > 0 then return cur end
local items = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[2]) - 1)
if #items == 0 then return {} end
redis.call('LTRIM', KEYS[1], #items, -1)
redis.call('RPUSH', KEYS[2], unpack(items))
return items`;

/**
 * KEYS: inflight, lock, queue. ARGV: token, ...events to retry.
 * Clears the in-flight batch (and re-queues the retries) only for the lock holder.
 */
export const FINISH_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
if #ARGV > 1 then redis.call('RPUSH', KEYS[3], unpack(ARGV, 2)) end
return 1`;

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

/** Write a claimed batch. Returns the events to retry. */
async function writeBatch(raw: string[]): Promise<QueuedConnEvent[]> {
  const events = raw.map(decodeEvent).filter((e): e is QueuedConnEvent => !!e);
  const groups = groupByIdentity(events);
  if (!groups.size) return [];
  const parts = await prisma.participant.findMany({
    where: { livekitIdentity: { in: [...groups.keys()] } },
    select: { livekitIdentity: true, studentId: true, classSessionId: true, role: true },
  });
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

  const failed: QueuedConnEvent[] = [];
  await runPool([...perRecord.values()], GROUP_CONCURRENCY, async (g) => {
    const ended = endedAt.get(g.cs) ?? null;
    const evs = applicableEvents([...g.events].sort((a, b) => a.at - b.at), ended);
    try {
      await applyConnectionEvents(
        g.cs,
        g.st,
        evs.map((e) => ({ kind: e.kind, sid: e.sid, at: new Date(e.at) })),
        ended
      );
    } catch (e) {
      console.error('[attendance] batch write failed', e instanceof Error ? e.message : e);
      failed.push(...g.events);
    }
  });
  const { retry, dropped } = retryable(failed);
  if (dropped) console.error(`[attendance] dropped ${dropped} event(s) after repeated write failures`);
  return retry;
}

/**
 * Drain the queue under the leader lock. `wait` (class end) waits for another
 * worker's flush to finish so the end sees every queued leave.
 */
export async function flushAttendanceQueue(opts: { wait?: boolean } = {}): Promise<void> {
  let token = await acquireLock(LOCK_KEY, LOCK_TTL_MS / 1000);
  const lockDeadline = Date.now() + 8_000;
  while (!token && opts.wait && Date.now() < lockDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    token = await acquireLock(LOCK_KEY, LOCK_TTL_MS / 1000);
  }
  if (!token) return;
  try {
    const redis = await ensureRedis();
    const start = Date.now();
    const budget = opts.wait ? END_FLUSH_BUDGET_MS : FLUSH_BUDGET_MS;
    while (Date.now() - start < budget) {
      const raw = (await redis.eval(
        CLAIM_LUA,
        3,
        ATTENDANCE_QUEUE_KEY,
        ATTENDANCE_INFLIGHT_KEY,
        LOCK_KEY,
        token,
        String(flushBatchSize()),
        String(LOCK_TTL_MS)
      )) as string[] | null;
      if (raw == null) {
        console.warn('[attendance] flush lock lost; the next leader continues');
        return;
      }
      if (!raw.length) return;
      const retry = await writeBatch(raw);
      const ok = await redis.eval(
        FINISH_LUA,
        3,
        ATTENDANCE_INFLIGHT_KEY,
        LOCK_KEY,
        ATTENDANCE_QUEUE_KEY,
        token,
        ...retry.map(encodeEvent)
      );
      if (Number(ok) !== 1) return;
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
