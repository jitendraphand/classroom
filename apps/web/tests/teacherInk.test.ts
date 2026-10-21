import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyInk, arrowHead, decodeInk, hitAnyPts, shapePts, validInkStroke, type InkStroke } from '../src/lib/teacherInk';

const stroke = (over: Partial<InkStroke> = {}): InkStroke => ({
  id: 'abcd',
  kind: 'pen',
  color: '#ef4444',
  width: 3,
  pts: [0.1, 0.2, 0.4, 0.5],
  ...over,
});

test('ink strokes reject bad ids, colours, and point lists', () => {
  assert.equal(validInkStroke(stroke()), true);
  assert.equal(validInkStroke(stroke({ id: 'no' })), false);
  assert.equal(validInkStroke(stroke({ color: 'red' })), false);
  assert.equal(validInkStroke(stroke({ pts: [0.1] })), false);
  assert.equal(validInkStroke(stroke({ pts: [0.1, 2] })), false);
  assert.equal(validInkStroke(stroke({ width: 0 })), false);
  assert.equal(validInkStroke(stroke({ kind: 'laser' as InkStroke['kind'] })), false);
});

test('decode and apply ink messages', () => {
  assert.equal(decodeInk({ v: 2, t: 'clear' }), null);
  assert.deepEqual(decodeInk({ v: 1, t: 'clear' }), { v: 1, t: 'clear' });
  const up = decodeInk({ v: 1, t: 'up', stroke: stroke() });
  assert.equal(up?.t, 'up');
  assert.equal(decodeInk({ v: 1, t: 'up', stroke: stroke({ id: 'x' }) }), null);
  let marks: InkStroke[] = [];
  marks = applyInk(marks, { v: 1, t: 'up', stroke: stroke() });
  assert.equal(marks.length, 1);
  marks = applyInk(marks, { v: 1, t: 'up', stroke: stroke({ pts: [0.2, 0.2, 0.3, 0.3] }) });
  assert.deepEqual(marks[0]?.pts, [0.2, 0.2, 0.3, 0.3]);
  assert.notEqual(marks[0]?.pts, stroke().pts);
  marks = applyInk(marks, { v: 1, t: 'del', id: 'abcd' });
  assert.equal(marks.length, 0);
  marks = applyInk([stroke()], { v: 1, t: 'snap', strokes: [stroke({ id: 'efgh' })] });
  assert.equal(marks[0]?.id, 'efgh');
  assert.deepEqual(applyInk(marks, { v: 1, t: 'clear' }), []);
});

test('shapes, arrow heads, and eraser hits', () => {
  const rect = shapePts('rect', 0, 0, 1, 1);
  assert.equal(rect.length, 10);
  assert.deepEqual(rect.slice(0, 2), [0, 0]);
  assert.deepEqual(rect.slice(-2), [0, 0]);
  assert.deepEqual(shapePts('line', 0.1, 0.2, 0.3, 0.4), [0.1, 0.2, 0.3, 0.4]);
  const head = arrowHead(0, 0, 1, 0);
  assert.equal(head.length, 6);
  assert.equal(head[2], 1);
  assert.equal(head[3], 0);
  const id = hitAnyPts([stroke({ pts: [0, 0, 1, 0] })], 0.5, 0, 0.05, 1);
  assert.equal(id, 'abcd');
  assert.equal(hitAnyPts([stroke({ pts: [0, 0, 1, 0] })], 0.5, 0.5, 0.02, 1), null);
  assert.equal(hitAnyPts([stroke({ id: 'old1', pts: [0, 0, 1, 0] }), stroke({ id: 'new1', pts: [0, 0, 1, 0] })], 0.5, 0, 0.05, 1), 'new1');
});
