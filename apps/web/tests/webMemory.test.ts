import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerMemoryPlan } from '../src/lib/webWorkers';
import { memo, memoSize, clearStateMemo } from '../src/lib/roomStateCache';

const root = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('worker memory plan: share of RAM per worker, heap 80% of it, overrides', () => {
  // Trial 2 box: 48 GB, 16 workers
  const p = workerMemoryPlan({ availableMb: 48 * 1024, workers: 16 });
  assert.equal(p.rssMb, 1536);
  assert.equal(p.heapMb, 1228);
  assert.equal(workerMemoryPlan({ availableMb: 4096, workers: 8 }).rssMb, 512);
  assert.equal(workerMemoryPlan({ availableMb: 256 * 1024, workers: 8 }).rssMb, 4096);
  assert.equal(workerMemoryPlan({ env: { WEB_WORKER_HEAP_MB: '2000' }, availableMb: 48 * 1024, workers: 16 }).heapMb, 2000);
  assert.equal(workerMemoryPlan({ env: { WEB_MEM_FRACTION: '0.25' }, availableMb: 48 * 1024, workers: 16 }).rssMb, 768);
  const cluster = root('cluster.js');
  assert.match(cluster, /DEFAULT_WEB_MEM_FRACTION = 0\.5;/);
  assert.match(cluster, /HEAP_OF_RSS = 0\.8;/);
  assert.match(cluster, /--max-old-space-size=/);
  assert.match(cluster, /memory\.max/);
});

test('state memo sweeps expired versioned entries instead of hoarding them', async () => {
  clearStateMemo();
  for (let v = 0; v < 100; v++) await memo(`state-shared:R:${v}`, 1000, async () => ({ big: v }), 10_000 + v * 2000);
  assert.ok(memoSize() <= 2, `size ${memoSize()}`);
  clearStateMemo();
  for (let i = 0; i < 1000; i++) void memo(`k${i}`, 60_000, async () => i, 5);
  assert.ok(memoSize() <= 256);
  clearStateMemo();
});

test('worker memory plan inside a container limit (small box): the workers own the limit', () => {
  // WEB_MEM_LIMIT=600m, one worker: 85% of the limit, heap 80% of that.
  const one = workerMemoryPlan({ availableMb: 600, workers: 1, limited: true });
  assert.equal(one.rssMb, 510);
  assert.equal(one.heapMb, 408);
  // Two workers in 1,280 MB.
  assert.equal(workerMemoryPlan({ availableMb: 1280, workers: 2, limited: true }).rssMb, 544);
  // Host RAM (no container limit) keeps the old behaviour.
  assert.equal(workerMemoryPlan({ availableMb: 4096, workers: 8 }).rssMb, 512);
  const cluster = root('cluster.js');
  assert.match(cluster, /DEFAULT_WEB_LIMIT_FRACTION = 0\.85;/);
});
