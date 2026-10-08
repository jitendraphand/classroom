import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAW_ALLOW_MS,
  applyPacket,
  cleanPoints,
  containRect,
  createPointBatcher,
  decodePacket,
  hitStroke,
  holderActive,
  lastStrokeOf,
  nameTags,
  q,
  strokeWidthFor,
  toNorm,
  type DrawPacket,
  type Stroke,
} from '../src/lib/drawLogic';
import { sortRoster } from '../src/lib/classSlots';

test('picture box: letterbox/pillarbox for object-fit: contain', () => {
  // 16:9 share on a 4:3 tablet: bars top and bottom.
  assert.deepEqual(containRect(1024, 768, 1920, 1080), { x: 0, y: 96, w: 1024, h: 576 });
  // 16:9 share on a 20:9 phone in landscape: bars left and right.
  const r = containRect(2400, 1080, 1920, 1080);
  assert.equal(r.h, 1080);
  assert.equal(Math.round(r.w), 1920);
  assert.equal(Math.round(r.x), 240);
  // Unknown video size: the whole element.
  assert.deepEqual(containRect(300, 200, 0, 0), { x: 0, y: 0, w: 300, h: 200 });
});

test('the same spot on the shared picture gives the same coordinates on every screen', () => {
  // The middle of the share's top-left quarter, seen on a tablet and a phone.
  const tab = containRect(1024, 768, 1920, 1080);
  const phone = containRect(2400, 1080, 1920, 1080);
  const a = toNorm(tab.x + tab.w * 0.25, tab.y + tab.h * 0.25, tab);
  const b = toNorm(phone.x + phone.w * 0.25, phone.y + phone.h * 0.25, phone);
  assert.deepEqual(a, [0.25, 0.25]);
  assert.deepEqual(b, [0.25, 0.25]);
  // Taps in the black bars clamp to the picture edge.
  assert.deepEqual(toNorm(5, 5, tab), [0.0049, 0]);
  assert.equal(q(1.7), 1);
  assert.ok(strokeWidthFor(300) >= 2 && strokeWidthFor(4000) <= 8);
});

test('client points are validated and rounded', () => {
  assert.deepEqual(cleanPoints([0.123456, 0.5, 1, 0]), [0.1235, 0.5, 1, 0]);
  assert.equal(cleanPoints([0.1]), null, 'odd length');
  assert.equal(cleanPoints([0.1, 2]), null, 'out of range');
  assert.equal(cleanPoints(['x', 0.1]), null);
  assert.equal(cleanPoints([]), null);
  assert.equal(cleanPoints(new Array(402).fill(0.5)), null, 'batch too large');
});

const pts = (id: string, from: number, p: number[], by = 'stu-1'): DrawPacket => ({ v: 1, t: 'pts', id, by, name: 'Asha', c: 'red', from, pts: p });

test('packets build strokes; overlapping packets after a snapshot are idempotent', () => {
  let s: Stroke[] = [];
  s = applyPacket(s, pts('abcd1', 0, [0.1, 0.1, 0.2, 0.2]));
  s = applyPacket(s, pts('abcd1', 4, [0.3, 0.3]));
  assert.deepEqual(s[0]!.pts, [0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
  // Late joiner: snapshot already has the first 6 values, then the 4.. packet arrives again.
  const again = applyPacket(s, pts('abcd1', 4, [0.3, 0.3, 0.4, 0.4]));
  assert.deepEqual(again[0]!.pts, [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
  s = applyPacket(again, pts('efgh2', 0, [0.9, 0.9], 'stu-2'));
  assert.equal(s.length, 2);
  s = applyPacket(s, { v: 1, t: 'del', id: 'abcd1' });
  assert.deepEqual(s.map((x) => x.id), ['efgh2']);
  assert.deepEqual(applyPacket(s, { v: 1, t: 'clear' }), []);
});

test('decodePacket rejects malformed data', () => {
  assert.equal(decodePacket(null), null);
  assert.equal(decodePacket({ v: 2, t: 'clear' }), null);
  assert.equal(decodePacket({ v: 1, t: 'pts', id: 'bad id!', by: 'x', name: 'n', c: 'red', from: 0, pts: [0.1, 0.1] }), null);
  assert.equal(decodePacket({ v: 1, t: 'pts', id: 'good1', by: 'x', name: 'n', c: 'green', from: 0, pts: [0.1, 0.1] }), null, 'only 3 colours');
  assert.deepEqual(decodePacket({ v: 1, t: 'del', id: 'good1' }), { v: 1, t: 'del', id: 'good1' });
  const ok = decodePacket({ v: 1, t: 'pts', id: 'good1', by: 'x', name: 'n', c: 'blue', from: -3, pts: [0.1, 0.1] });
  assert.equal(ok && ok.t === 'pts' && ok.from, 0);
});

test('eraser and undo only touch the drawer’s own strokes', () => {
  const strokes: Stroke[] = [
    { id: 'mine1', by: 'me', name: 'Me', color: 'red', pts: [0.1, 0.5, 0.9, 0.5] },
    { id: 'other', by: 'you', name: 'You', color: 'blue', pts: [0.1, 0.52, 0.9, 0.52] },
    { id: 'mine2', by: 'me', name: 'Me', color: 'yellow', pts: [0.5, 0.9] },
  ];
  assert.equal(hitStroke(strokes, 'me', 0.5, 0.51), 'mine1', 'the other student’s stroke on top is skipped');
  assert.equal(hitStroke(strokes, 'you', 0.5, 0.51), 'other');
  assert.equal(hitStroke(strokes, 'me', 0.5, 0.2), null);
  assert.equal(hitStroke(strokes, 'me', 0.501, 0.9), 'mine2', 'a dot');
  assert.equal(lastStrokeOf(strokes, 'me'), 'mine2');
  assert.equal(lastStrokeOf(strokes, 'nobody'), null);
  assert.deepEqual(
    nameTags(strokes).map((t) => [t.by, t.x, t.y]),
    [
      ['me', 0.5, 0.9],
      ['you', 0.9, 0.52],
    ]
  );
});

test('allow expires', () => {
  const now = 1_000_000;
  const h = { participantId: 'p', identity: 'i', name: 'n', until: now + DRAW_ALLOW_MS };
  assert.equal(holderActive(h, now), true);
  assert.equal(holderActive(h, now + DRAW_ALLOW_MS + 1), false);
  assert.equal(holderActive(null, now), false);
});

test('batcher: one request in flight, in order, with correct start indexes', async () => {
  const sent: { id: string; from: number; pts: number[] }[] = [];
  const timers: (() => void)[] = [];
  let release: () => void = () => {};
  const b = createPointBatcher(
    (x) => {
      sent.push({ id: x.id, from: x.from, pts: [...x.pts] });
      return new Promise<void>((res) => (release = res));
    },
    80,
    (fn) => timers.push(fn)
  );
  b.add('s1', 'red', [0.1, 0.1]);
  b.add('s1', 'red', [0.2, 0.2]); // merged into the same batch
  timers.shift()!();
  await Promise.resolve();
  assert.deepEqual(sent, [{ id: 's1', from: 0, pts: [0.1, 0.1, 0.2, 0.2] }]);
  b.add('s1', 'red', [0.3, 0.3]); // while the first is in flight
  assert.equal(sent.length, 1, 'waits for the first request');
  release();
  await new Promise((r) => setTimeout(r, 0));
  timers.shift()!();
  await Promise.resolve();
  assert.deepEqual(sent[1], { id: 's1', from: 4, pts: [0.3, 0.3] });
  release();
});

test('roster: the drawer, then draw requests (earliest first), then hands', () => {
  const people = [
    { id: 'a', displayName: 'Anu', role: 'STUDENT' },
    { id: 'b', displayName: 'Bela', role: 'STUDENT', handRaised: true, handRaisedAt: 1 },
    { id: 'c', displayName: 'Chen', role: 'STUDENT', drawRequested: true, drawRequestedAt: 20 },
    { id: 'd', displayName: 'Dev', role: 'STUDENT', drawRequested: true, drawRequestedAt: 10 },
    { id: 'e', displayName: 'Esha', role: 'STUDENT', drawing: true },
  ];
  assert.deepEqual(sortRoster(people).map((p) => p.id), ['e', 'd', 'c', 'b', 'a']);
});
