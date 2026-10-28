import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUNDS,
  LASER_MS,
  LaserTrail,
  PointBatcher,
  applyOp,
  cleanDoc,
  cleanItem,
  emptyDoc,
  hitItem,
  inverseOf,
  pressurePct,
  transformItem,
  type Item,
  type Op,
} from '../src/lib/whiteboard/model';
import { widthAt } from '../src/lib/whiteboard/render';
import { recognizeShape, resample } from '../src/lib/whiteboard/recognize';
import { WhiteboardSession, laserPacket } from '../src/lib/whiteboard/session';
import { sanitizeStudentOps } from '../src/lib/whiteboardServer';

const stroke = (pts: number[], pr?: number[]): Item => ({ k: 'stroke', id: 'a1', by: 't', tool: 'pen', c: '#111111', w: 4, pts, ...(pr ? { pr } : {}) });

test('pressure: kept for pen strokes with one value per point, dropped otherwise', () => {
  const ok = cleanItem(stroke([0, 0, 10, 10], [20, 140]));
  assert.deepEqual((ok as { pr?: number[] }).pr, [20, 100]);
  const wrongLength = cleanItem(stroke([0, 0, 10, 10], [20]));
  assert.equal((wrongLength as { pr?: number[] }).pr, undefined);
  const hl = cleanItem({ ...stroke([0, 0, 10, 10], [20, 30]), tool: 'hl' });
  assert.equal((hl as { pr?: number[] }).pr, undefined);
  assert.equal(pressurePct(0.42), 42);
  assert.equal(pressurePct(NaN), 50);
  assert.ok(widthAt(10, 0) < widthAt(10, 50) && widthAt(10, 50) < widthAt(10, 100));
});

test('pressure: appended points keep the arrays aligned, missing values repeat the last', () => {
  const doc = emptyDoc();
  const p = doc.pages[0]!.id;
  applyOp(doc, { k: 'add', p, item: stroke([0, 0], [30]) });
  applyOp(doc, { k: 'pts', p, id: 'a1', pts: [5, 5, 6, 6], pr: [60, 70] });
  applyOp(doc, { k: 'pts', p, id: 'a1', pts: [7, 7] });
  const s = doc.pages[0]!.items[0] as { pts: number[]; pr: number[] };
  assert.equal(s.pts.length / 2, s.pr.length);
  assert.deepEqual(s.pr, [30, 60, 70, 70]);
});

test('batcher: pressure only when the stroke has it, duplicates dropped across flushes', () => {
  const b = new PointBatcher('p', 's1', true);
  b.push(1, 1, 0.5);
  b.push(1, 1, 0.9);
  b.push(2, 2, 0.25);
  assert.deepEqual(b.peek(), [1, 1, 2, 2]);
  assert.deepEqual(b.flush(), { k: 'pts', p: 'p', id: 's1', pts: [1, 1, 2, 2], pr: [50, 25] });
  b.push(2, 2, 1);
  assert.equal(b.flush(), null);
  const plain = new PointBatcher('p', 's2');
  plain.push(3, 3, 0.7);
  assert.deepEqual(plain.flush(), { k: 'pts', p: 'p', id: 's2', pts: [3, 3] });
});

test('xf: move and resize selected items, undo restores them exactly', () => {
  const doc = emptyDoc();
  const p = doc.pages[0]!.id;
  applyOp(doc, { k: 'add', p, item: { k: 'rect', id: 'r1', by: 't', c: '#111111', w: 4, x1: 100, y1: 100, x2: 200, y2: 200 } });
  applyOp(doc, { k: 'add', p, item: { k: 'text', id: 't1', by: 't', c: '#111111', size: 40, x: 10, y: 10, text: 'Hi' } });
  const op: Op = { k: 'xf', p, ids: ['r1'], s: 2, ox: 100, oy: 100, dx: 50, dy: 0 };
  const before = JSON.parse(JSON.stringify(doc.pages[0]));
  const undo = inverseOf(op, before, doc);
  assert.ok(applyOp(doc, op));
  const r = doc.pages[0]!.items[0] as { x1: number; x2: number; y2: number; w: number };
  assert.deepEqual([r.x1, r.x2, r.y2, r.w], [150, 350, 300, 8]);
  assert.equal((doc.pages[0]!.items[1] as { x: number }).x, 10, 'unselected items stay put');
  for (const u of undo) applyOp(doc, u);
  assert.deepEqual(doc.pages[0], before);
  assert.equal(applyOp(doc, { k: 'xf', p, ids: ['nope'], s: 1, ox: 0, oy: 0, dx: 5, dy: 5 }), false);
});

test('xf: strokes, text and images scale with the selection', () => {
  const t = { s: 0.5, ox: 0, oy: 0, dx: 10, dy: 20 };
  const s = transformItem(stroke([100, 100, 200, 300], [10, 90]), t) as { pts: number[]; w: number; pr: number[] };
  assert.deepEqual(s.pts, [60, 70, 110, 170]);
  assert.equal(s.w, 2);
  assert.deepEqual(s.pr, [10, 90]);
  const txt = transformItem({ k: 'text', id: 'x', by: 't', c: '#111111', size: 40, x: 100, y: 100, text: 'a' }, t) as { size: number; x: number };
  assert.deepEqual([txt.size, txt.x], [20, 60]);
});

test('triangle and filled shapes: validated, hit-tested on their edges', () => {
  const tri = cleanItem({ k: 'tri', id: 'g1', by: 't', c: '#e53935', w: 4, x1: 0, y1: 0, x2: 200, y2: 100, fl: 1 });
  assert.equal(tri?.k, 'tri');
  assert.equal((tri as { fl?: number }).fl, 1);
  assert.equal((cleanItem({ k: 'line', id: 'g2', by: 't', c: '#111111', w: 4, x1: 0, y1: 0, x2: 1, y2: 1, fl: 1 }) as { fl?: number }).fl, undefined);
  assert.ok(hitItem(tri!, 100, 0, 3), 'apex');
  assert.ok(hitItem(tri!, 100, 100, 3), 'base');
  assert.ok(!hitItem(tri!, 100, 60, 3), 'inside, away from the edges');
});

test('backgrounds: dots and graph survive a snapshot; unknown ones fall back to white', () => {
  assert.ok(BACKGROUNDS.includes('dots') && BACKGROUNDS.includes('graph'));
  const doc = cleanDoc({ v: 1, cur: 0, pages: [{ id: 'p1', bg: 'graph', items: [] }, { id: 'p2', bg: 'stars', items: [] }] });
  assert.deepEqual(doc?.pages.map((p) => p.bg), ['graph', 'white']);
});

test('laser: trail fades after LASER_MS; packets reach the session without changing the board', async () => {
  const trail = new LaserTrail();
  trail.add([10, 10, 20, 20], 1000);
  assert.ok(trail.prune(1000 + LASER_MS - 1));
  assert.ok(!trail.prune(1000 + LASER_MS + 1));
  const s = new WhiteboardSession(undefined, true);
  let laserHits = 0;
  s.onLaser(() => laserHits++);
  const v0 = s.version;
  await s.receive(laserPacket([100.4, 200.6]));
  assert.equal(laserHits, 1);
  assert.equal(s.version, v0, 'no board change');
  assert.deepEqual(s.laser.pts.map((p) => [p.x, p.y]), [[100, 201]]);
});

test('student relay: pressure passes through with the points', () => {
  const ops = sanitizeStudentOps([{ k: 'pts', p: 'p1', id: 's9', pts: [1, 2, 3, 4], pr: [10, 200] }], 'student_x');
  assert.deepEqual(ops, [{ k: 'pts', p: 'p1', id: 's9', pts: [1, 2, 3, 4], pr: [10, 100] }]);
});

const circle = (cx: number, cy: number, r: number, n = 60, wobble = 0) => {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r + (i % 2 ? wobble : -wobble);
    out.push(Math.round(cx + rr * Math.cos(a)), Math.round(cy + rr * Math.sin(a)));
  }
  return out;
};
const polyline = (pts: [number, number][], per = 15) => {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    for (let j = 0; j < per; j++) out.push(Math.round(a[0] + ((b[0] - a[0]) * j) / per), Math.round(a[1] + ((b[1] - a[1]) * j) / per));
  }
  const last = pts[pts.length - 1]!;
  out.push(last[0], last[1]);
  return out;
};

test('snap: a shaky line becomes a straight line, snapped to horizontal', () => {
  const pts: number[] = [];
  for (let x = 100; x <= 600; x += 10) pts.push(x, 300 + (x % 20 ? 3 : -3) + Math.round((x - 100) * 0.04));
  const s = recognizeShape(pts);
  assert.equal(s?.k, 'line');
  assert.equal(s?.y1, s?.y2, 'within 6 degrees: snapped flat');
});

test('snap: rough circle, ellipse, box and triangle', () => {
  const c = recognizeShape(circle(500, 400, 150, 60, 4));
  assert.equal(c?.k, 'ellipse');
  assert.equal(c!.x2 - c!.x1, c!.y2 - c!.y1, 'near-circle becomes a circle');
  const wide: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    wide.push(Math.round(500 + 300 * Math.cos(a)), Math.round(400 + 120 * Math.sin(a)));
  }
  const e = recognizeShape(wide);
  assert.equal(e?.k, 'ellipse');
  assert.ok(e!.x2 - e!.x1 > 2 * (e!.y2 - e!.y1));
  assert.equal(recognizeShape(polyline([[100, 100], [500, 102], [498, 400], [102, 398], [100, 104]]))?.k, 'rect');
  assert.equal(recognizeShape(polyline([[300, 100], [500, 400], [100, 400], [298, 106]]))?.k, 'tri');
});

test('snap: scribbles, tiny marks and open curves stay free-hand', () => {
  assert.equal(recognizeShape([0, 0, 5, 5, 10, 0, 15, 5]), null, 'too small');
  const zigzag = polyline([[100, 100], [200, 300], [300, 100], [400, 300], [500, 100]]);
  assert.equal(recognizeShape(zigzag), null);
  const arc: number[] = [];
  for (let i = 0; i <= 30; i++) {
    const a = (i / 30) * Math.PI;
    arc.push(Math.round(400 + 200 * Math.cos(a)), Math.round(400 - 200 * Math.sin(a)));
  }
  assert.equal(recognizeShape(arc), null, 'half circle is not closed');
});

test('resample: evenly spaced points along the path', () => {
  const r = resample([{ x: 0, y: 0 }, { x: 100, y: 0 }], 5);
  assert.deepEqual(r.map((p) => Math.round(p.x)), [0, 25, 50, 75, 100]);
});
