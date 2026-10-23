import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedWorkQueue, TtlCache } from '../src/lib/webhookQueue';

test('webhook queue: per-key order, cross-key concurrency, bounded', async () => {
  const seen: string[] = [];
  let maxActive = 0;
  let active = 0;
  const q = new KeyedWorkQueue<{ k: string; n: number }>({
    keyOf: (i) => i.k,
    concurrency: 4,
    handle: async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      seen.push(`${i.k}${i.n}`);
      active--;
    },
  });
  for (let n = 0; n < 5; n++) for (const k of ['a', 'b', 'c']) q.push({ k, n });
  await q.idle();
  for (const k of ['a', 'b', 'c']) {
    const order = seen.filter((s) => s.startsWith(k));
    assert.deepEqual(order, [0, 1, 2, 3, 4].map((n) => `${k}${n}`));
  }
  assert.ok(maxActive > 1 && maxActive <= 4);

  let dropped = 0;
  const small = new KeyedWorkQueue<number>({ keyOf: () => 'x', maxSize: 3, handle: async () => undefined, onDrop: (n) => (dropped += n) });
  for (let i = 0; i < 10; i++) small.push(i);
  assert.ok(small.size <= 3);
  assert.equal(dropped, 7);
  await small.idle();
});

test('ttl cache expires and stays bounded', () => {
  const c = new TtlCache<number>(100, 2);
  c.set('a', 1, 0);
  assert.equal(c.get('a', 50), 1);
  assert.equal(c.get('a', 200), undefined);
  c.set('a', 1, 0);
  c.set('b', 2, 0);
  c.set('c', 3, 0);
  assert.equal(c.size, 2);
  assert.equal(c.get('a', 0), undefined);
});
