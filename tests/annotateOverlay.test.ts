import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ShapeLog,
  applyRemoteMessage,
  cssPointerToNormalized,
  normalizePhysical,
  parseShape,
  shapesHit,
  type AnnotShape,
} from '../src/shared/annotateOverlay';

function pen(id: string, points: [number, number][]): AnnotShape {
  return { id, type: 'pen', points, color: '#ef4444', width: 3, opacity: 1, text: '', timestamp: 1 };
}

test('the same physical point is 0–1 at 100%, 125%, 150%, 175%, and 200%', () => {
  const scales = [1, 1.25, 1.5, 1.75, 2];
  for (const scale of scales) {
    const dipW = 1920 / scale;
    const dipH = 1080 / scale;
    const point = cssPointerToNormalized(
      { x: dipW / 2, y: dipH / 2 },
      { x: 0, y: 0, w: dipW, h: dipH },
      scale,
      { x: 0, y: 0, widthPx: 1920, heightPx: 1080 }
    );
    assert.deepEqual(point, [0.5, 0.5], `scale ${scale}`);
  }
});

test('a 150% monitor beside a 100% monitor does not scale the virtual-screen origin', () => {
  // Primary is 1920 physical pixels wide at 100%. The next monitor is 150%:
  // its DIP origin is 1920, its physical origin is also 1920, not 1920 × 1.5.
  const edge = cssPointerToNormalized(
    { x: 0, y: 0 },
    { x: 1920, y: 0, w: 1280, h: 720 },
    1.5,
    { x: 1920, y: 0, widthPx: 1920, heightPx: 1080 }
  );
  const mid = cssPointerToNormalized(
    { x: 640, y: 360 },
    { x: 1920, y: 0, w: 1280, h: 720 },
    1.5,
    { x: 1920, y: 0, widthPx: 1920, heightPx: 1080 }
  );
  assert.deepEqual(edge, [0, 0]);
  assert.deepEqual(mid, [0.5, 0.5]);
});

test('a monitor left of the primary and one to the right keep their own 0–1 space', () => {
  const left = cssPointerToNormalized(
    { x: 0, y: 0 },
    { x: -1920, y: 0, w: 1920, h: 1080 },
    1,
    { x: -1920, y: 0, widthPx: 1920, heightPx: 1080 }
  );
  const right = cssPointerToNormalized(
    { x: 960, y: 540 },
    { x: 1920, y: 0, w: 1920, h: 1080 },
    1,
    { x: 1920, y: 0, widthPx: 1920, heightPx: 1080 }
  );
  assert.deepEqual(left, [0, 0]);
  assert.deepEqual(right, [0.5, 0.5]);
});

test('a remote pixel maps into the host monitor even when the sizes differ', () => {
  assert.deepEqual(normalizePhysical(960, 540, 1920, 1080), [0.5, 0.5]);
  assert.deepEqual(normalizePhysical(640, 360, 1280, 720), [0.5, 0.5]);
  assert.equal(normalizePhysical(1, 1, 0, 10), null);
});

test('undo, redo, and clear restore the vector document', () => {
  const log = new ShapeLog();
  log.add(pen('a', [[0.1, 0.1], [0.2, 0.2]]));
  log.add(pen('b', [[0.3, 0.3]]));
  assert.equal(log.shapes.length, 2);
  assert.equal(log.undo(), true);
  assert.deepEqual(log.shapes.map((s) => s.id), ['a']);
  assert.equal(log.redo(), true);
  assert.deepEqual(log.shapes.map((s) => s.id), ['a', 'b']);
  log.clear();
  assert.equal(log.shapes.length, 0);
  log.undo();
  assert.deepEqual(log.shapes.map((s) => s.id), ['a', 'b']);
});

test('eraser removes the shape under the pointer and undo puts it back', () => {
  const log = new ShapeLog();
  const line = pen('line', [[0.1, 0.5], [0.9, 0.5]]);
  log.add(line);
  const hit = shapesHit(log.shapes, [0.5, 0.5], 16 / 9);
  assert.deepEqual(hit, ['line']);
  log.erase(hit);
  assert.equal(log.shapes.length, 0);
  log.undo();
  assert.equal(log.shapes[0]?.id, 'line');
});

test('a remote physical pixel is divided by the captured monitor size', () => {
  const log = new ShapeLog();
  assert.equal(
    applyRemoteMessage(log, {
      v: 1,
      type: 'shape',
      screenWidthPx: 1280,
      screenHeightPx: 720,
      shape: {
        id: 'px',
        type: 'line',
        points: [
          [640, 360],
          [0, 0],
        ],
        color: '#ffffff',
        width: 3,
        opacity: 1,
        text: '',
        timestamp: 1,
      },
    }),
    true
  );
  assert.deepEqual(log.shapes[0]?.points, [
    [0.5, 0.5],
    [0, 0],
  ]);
});

test('laser is not stored as a shape', () => {
  assert.equal(
    parseShape({ id: 'l', type: 'laser', points: [[0.5, 0.5]], color: '#fb7185', width: 3, opacity: 1, text: '', timestamp: 1 }),
    null
  );
});

test('a remote shape and a legacy pen are drawn once and are not echoed by the log', () => {
  const log = new ShapeLog();
  assert.equal(
    applyRemoteMessage(log, {
      v: 1,
      type: 'shape',
      shape: { id: 'r1', type: 'arrow', points: [[0.2, 0.2], [0.4, 0.5]], color: '#3b82f6', width: 3, opacity: 1, text: '', timestamp: 2 },
    }),
    true
  );
  assert.equal(log.shapes[0]?.type, 'arrow');
  assert.equal(
    applyRemoteMessage(log, {
      v: 1,
      type: 'begin',
      from: 'observer',
      stroke: { id: 's1', tool: 'highlighter', color: '#f59e0b', width: 18, points: [[0.1, 0.1]] },
    }),
    true
  );
  assert.equal(log.shapes[1]?.type, 'highlight');
  assert.equal(log.shapes[1]?.opacity, 0.35);
  applyRemoteMessage(log, { v: 1, type: 'points', id: 's1', pts: [[0.2, 0.2]], from: 'observer' });
  assert.equal(log.shapes[1]?.points.length, 2);
  applyRemoteMessage(log, { v: 1, type: 'clear', from: 'observer' });
  assert.equal(log.shapes.length, 0);
});
