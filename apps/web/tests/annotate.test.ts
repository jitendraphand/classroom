import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distToSegment,
  fitSnapshot,
  mergeSnapshot,
  quantize,
  strokeHit,
  SNAPSHOT_BUDGET_BYTES,
  type Pt,
} from '../src/lib/annotateGeometry';

const stroke = (id: string, points: Pt[], width = 3) => ({ id, width, points });

test('quantize clamps to 0..1 and keeps 4 decimals', () => {
  assert.deepEqual(quantize([0.123456789, 1.7]), [0.1235, 1]);
  assert.deepEqual(quantize([-0.2, 0.5]), [0, 0.5]);
  assert.ok(JSON.stringify(quantize([0.333333333333, 0.666666666666])).length <= 15);
});

test('distToSegment measures to the segment, not just the ends', () => {
  assert.equal(distToSegment([0.5, 0.5], [0, 0.5], [1, 0.5]), 0);
  assert.ok(Math.abs(distToSegment([0.5, 0.6], [0, 0.5], [1, 0.5]) - 0.1) < 1e-9);
  // Past the end: distance to the endpoint.
  assert.ok(Math.abs(distToSegment([1.3, 0.5], [0, 0.5], [1, 0.5]) - 0.3) < 1e-9);
  // Degenerate segment.
  assert.ok(Math.abs(distToSegment([0.3, 0.4], [0, 0], [0, 0]) - 0.5) < 1e-9);
});

test('eraser hits the middle of a two-point line (was vertex-only)', () => {
  const line = stroke('a', [
    [0.1, 0.5],
    [0.9, 0.5],
  ]);
  assert.equal(strokeHit(line, [0.5, 0.505]), true);
  assert.equal(strokeHit(line, [0.5, 0.6]), false);
  assert.equal(strokeHit(stroke('dot', [[0.2, 0.2]]), [0.205, 0.2]), true);
});

test('mergeSnapshot keeps strokes drawn before join and live ones received during the fetch', () => {
  const snap = [stroke('old1', [[0.1, 0.1]]), stroke('cur', [[0.2, 0.2]])];
  const live = [
    stroke('cur', [
      [0.2, 0.2],
      [0.3, 0.3],
    ]),
    stroke('new', [[0.5, 0.5]]),
  ];
  const merged = mergeSnapshot(snap, live);
  assert.deepEqual(
    merged.map((s) => s.id),
    ['old1', 'cur', 'new']
  );
  assert.equal(merged[1]!.points.length, 2, 'longer live copy wins');
  // A stroke erased live is not resurrected by a stale snapshot.
  assert.deepEqual(
    mergeSnapshot(snap, [], new Set(['old1'])).map((s) => s.id),
    ['cur']
  );
});

test('fitSnapshot drops the oldest strokes to stay under the server cap', () => {
  const pts: Pt[] = Array.from({ length: 1000 }, (_, i) => [i / 1000, 0.123456789012345]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, tool: 'pen', color: '#fff', width: 3, points: pts }));
  const fitted = fitSnapshot(many);
  assert.ok(JSON.stringify({ strokes: fitted }).length <= SNAPSHOT_BUDGET_BYTES);
  assert.ok(fitted.length > 0 && fitted.length < many.length);
  assert.equal(fitted[fitted.length - 1]!.id, 's29', 'newest kept');
  const small = many.slice(0, 2);
  assert.equal(fitSnapshot(small), small);
});
