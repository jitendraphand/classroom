/**
 * LiveKit webhook work queue (load test 2026-10-22: "failed to notify webhook:
 * queue is full" at 2,000 students). The HTTP handler only verifies the
 * signature, enqueues, and answers 200 at once; this queue drains the events
 * in the background in small batches with bounded concurrency.
 *
 * In-memory per web worker: LiveKit spreads deliveries over the workers, and
 * nothing here needs cross-worker ordering. Events for one room are processed
 * in arrival order (one room never runs two events at a time). The queue is
 * bounded: when full, the oldest events are dropped (presence also has the
 * client heartbeat, so a lost join/leave self-heals).
 */

export type QueueOptions<T> = {
  /** Room (or other ordering key) of an item. */
  keyOf: (item: T) => string;
  handle: (item: T) => Promise<void>;
  maxSize?: number;
  /** Items started per drain tick. */
  batchSize?: number;
  /** Different keys handled at the same time. */
  concurrency?: number;
  onDrop?: (dropped: number) => void;
};

export class KeyedWorkQueue<T> {
  private items: T[] = [];
  private running = new Set<string>();
  private active = 0;
  private scheduled = false;
  private dropped = 0;
  private idleWaiters: (() => void)[] = [];
  readonly maxSize: number;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(private readonly opts: QueueOptions<T>) {
    this.maxSize = Math.max(1, opts.maxSize ?? 20_000);
    this.batchSize = Math.max(1, opts.batchSize ?? 50);
    this.concurrency = Math.max(1, opts.concurrency ?? 16);
  }

  get size() {
    return this.items.length;
  }
  get inFlight() {
    return this.active;
  }
  get droppedTotal() {
    return this.dropped;
  }

  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.maxSize) {
      const over = this.items.length - this.maxSize;
      this.items.splice(0, over);
      this.dropped += over;
      this.opts.onDrop?.(over);
    }
    this.schedule();
  }

  /** Resolves once nothing is queued or running (tests, graceful shutdown). */
  idle(): Promise<void> {
    if (!this.items.length && !this.active) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain() {
    let started = 0;
    for (let i = 0; i < this.items.length && started < this.batchSize && this.active < this.concurrency; ) {
      const item = this.items[i]!;
      const key = this.opts.keyOf(item);
      if (this.running.has(key)) {
        i++;
        continue;
      }
      this.items.splice(i, 1);
      started++;
      this.run(key, item);
    }
    if (!this.items.length && !this.active) {
      const w = this.idleWaiters.splice(0);
      for (const f of w) f();
    }
  }

  private run(key: string, item: T) {
    this.running.add(key);
    this.active++;
    void this.opts
      .handle(item)
      .catch((e) => console.error('webhook queue item failed', e instanceof Error ? e.message : e))
      .finally(() => {
        this.running.delete(key);
        this.active--;
        if (this.items.length) this.schedule();
        else if (!this.active) {
          const w = this.idleWaiters.splice(0);
          for (const f of w) f();
        }
      });
  }
}

/** Events the classroom acts on. Everything else (track_*, egress_*, ...) is acked and dropped. */
export const HANDLED_WEBHOOK_EVENTS = new Set([
  'participant_joined',
  'participant_left',
  'participant_connection_aborted',
  'room_finished',
]);

/** Small TTL cache for read-mostly lookups done once per webhook event. */
export class TtlCache<V> {
  private m = new Map<string, { v: V; at: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 1000
  ) {}
  get(k: string, now = Date.now()): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: V, now = Date.now()) {
    this.m.delete(k);
    this.m.set(k, { v, at: now });
    while (this.m.size > this.max) {
      const first = this.m.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.m.delete(first);
    }
  }
  delete(k: string) {
    this.m.delete(k);
  }
  get size() {
    return this.m.size;
  }
}
