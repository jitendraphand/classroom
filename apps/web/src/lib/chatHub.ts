import type Redis from 'ioredis';

/**
 * One Redis subscriber connection per web worker, fanned out to every SSE
 * viewer in that worker. The chat stream used to `redis.duplicate()` per
 * viewer: 2,000 students meant 2,000 Redis connections, each with its own
 * buffers, and a viewer whose stream was cancelled (instead of aborted) kept
 * its connection forever. Listeners here are a Set per channel; the channel
 * is unsubscribed when its last listener leaves.
 */
export type ChatListener = (raw: string) => void;

type HubState = {
  sub: Redis | null;
  connecting: Promise<Redis> | null;
  channels: Map<string, Set<ChatListener>>;
};

const g = globalThis as unknown as { __chatHub?: HubState };
const state: HubState = (g.__chatHub ??= { sub: null, connecting: null, channels: new Map() });

async function subscriber(base: () => Promise<Redis>): Promise<Redis> {
  if (state.sub) return state.sub;
  if (!state.connecting) {
    state.connecting = (async () => {
      const r = (await base()).duplicate();
      r.on('message', (channel: string, raw: string) => {
        const set = state.channels.get(channel);
        if (!set) return;
        for (const fn of [...set]) {
          try {
            fn(raw);
          } catch {
            /* one bad listener never breaks the rest */
          }
        }
      });
      r.on('error', () => undefined);
      // ioredis re-subscribes known channels on reconnect by itself.
      if (r.status === 'wait' || r.status === 'end') await r.connect();
      state.sub = r;
      return r;
    })().finally(() => {
      state.connecting = null;
    });
  }
  return state.connecting;
}

/** Subscribe; returns an idempotent unsubscribe. */
export async function subscribeChat(
  base: () => Promise<Redis>,
  channel: string,
  fn: ChatListener,
): Promise<() => void> {
  let set = state.channels.get(channel);
  const fresh = !set;
  if (!set) {
    set = new Set();
    state.channels.set(channel, set);
  }
  set.add(fn);
  if (fresh) {
    const r = await subscriber(base);
    await r.subscribe(channel);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = state.channels.get(channel);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) {
      state.channels.delete(channel);
      void state.sub?.unsubscribe(channel).catch(() => undefined);
    }
  };
}

export function chatHubStats() {
  let listeners = 0;
  for (const s of state.channels.values()) listeners += s.size;
  return { channels: state.channels.size, listeners };
}
