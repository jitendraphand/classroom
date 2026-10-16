import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChunkAssembler,
  PointBatcher,
  applyOp,
  chunkPackets,
  cleanItem,
  decodePacket,
  emptyDoc,
  encodePacket,
  hitItem,
  inverseOf,
  itemsInRect,
  studentOpAllowed,
  type Op,
  type Packet,
} from '../src/lib/whiteboard/model';
import { decodeSnapshot, encodeSnapshot } from '../src/lib/whiteboard/codec';
import { WhiteboardSession, opsPackets } from '../src/lib/whiteboard/session';
import { jpegsToPdf } from '../src/lib/whiteboard/pdf';
import { sanitizeStudentOps } from '../src/lib/whiteboardServer';

const stroke = (id: string, by = 'teacher_1', pts = [10, 10, 100, 100]) => ({ k: 'stroke' as const, id, by, tool: 'pen' as const, c: '#111111', w: 4, pts });

test('ops: add, append points, delete, clear, pages, background, delBy', () => {
  const d = emptyDoc();
  const p = d.pages[0]!.id;
  assert.ok(applyOp(d, { k: 'add', p, item: stroke('t1') }));
  assert.ok(applyOp(d, { k: 'pts', p, id: 't1', pts: [200, 200] }));
  assert.deepEqual((d.pages[0]!.items[0] as { pts: number[] }).pts, [10, 10, 100, 100, 200, 200]);
  assert.ok(applyOp(d, { k: 'add', p, item: stroke('s1', 'student_9') }));
  assert.ok(applyOp(d, { k: 'delBy', by: 'student_9' }));
  assert.equal(d.pages[0]!.items.length, 1);
  assert.ok(applyOp(d, { k: 'bg', p, bg: 'grid' }));
  assert.equal(d.pages[0]!.bg, 'grid');
  assert.ok(applyOp(d, { k: 'newpage', at: 1, id: 'p2', bg: 'black' }));
  assert.equal(d.cur, 1);
  assert.ok(applyOp(d, { k: 'go', cur: 0 }));
  assert.ok(applyOp(d, { k: 'del', p, ids: ['t1'] }));
  assert.equal(d.pages[0]!.items.length, 0);
  assert.equal(applyOp(d, { k: 'clear', p }), false);
  assert.ok(applyOp(d, { k: 'delpage', p: 'p2' }));
  assert.equal(d.pages.length, 1);
});

test('items are validated (bad colour, bad image, missing id)', () => {
  assert.equal(cleanItem({ k: 'stroke', id: 'bad id!', pts: [] }), null);
  assert.equal(cleanItem({ k: 'img', id: 'i1', src: 'javascript:alert(1)', x: 0, y: 0, w: 1, h: 1 }), null);
  const s = cleanItem({ k: 'stroke', id: 'x', c: 'red;', w: 999, pts: [1.4, 2.6] });
  assert.ok(s && s.k === 'stroke' && s.c === '#111111' && s.w === 80);
  assert.deepEqual(s && s.k === 'stroke' && s.pts, [1, 3]);
});

test('undo inverses restore the page', () => {
  const d = emptyDoc();
  const p = d.pages[0]!.id;
  applyOp(d, { k: 'add', p, item: stroke('a') });
  applyOp(d, { k: 'add', p, item: stroke('b') });
  const before = JSON.parse(JSON.stringify(d.pages[0]));
  const op: Op = { k: 'clear', p };
  const inv = inverseOf(op, before, d);
  applyOp(d, op);
  assert.equal(d.pages[0]!.items.length, 0);
  for (const o of inv) applyOp(d, o);
  assert.deepEqual(d.pages[0]!.items.map((x) => x.id), ['a', 'b']);
});

test('eraser hit tests: stroke, shapes, area', () => {
  assert.ok(hitItem(stroke('a'), 55, 55, 3));
  assert.ok(!hitItem(stroke('a'), 300, 10, 3));
  assert.ok(hitItem({ k: 'rect', id: 'r', by: 't', c: '#111111', w: 2, x1: 0, y1: 0, x2: 100, y2: 100 }, 100, 50, 2));
  assert.ok(!hitItem({ k: 'rect', id: 'r', by: 't', c: '#111111', w: 2, x1: 0, y1: 0, x2: 100, y2: 100 }, 50, 50, 2));
  const d = emptyDoc();
  const p = d.pages[0]!;
  applyOp(d, { k: 'add', p: p.id, item: stroke('a') });
  applyOp(d, { k: 'add', p: p.id, item: stroke('b', 't', [900, 900, 950, 950]) });
  assert.deepEqual(itemsInRect(d.pages[0]!, 0, 0, 200, 200), ['a']);
});

test('point batching: one pts op per flush, duplicates dropped', () => {
  const b = new PointBatcher('p', 's1');
  b.push(1, 1);
  b.push(1, 1);
  b.push(2.4, 3.6);
  assert.deepEqual(b.flush(), { k: 'pts', p: 'p', id: 's1', pts: [1, 1, 2, 4] });
  assert.equal(b.flush(), null);
});

test('chunking: big packets split and reassemble in any order', () => {
  const big: Packet = { v: 1, t: 'snap', doc: 'x'.repeat(40_000), z: 0 };
  const parts = chunkPackets(JSON.stringify(big));
  assert.ok(parts.length >= 4);
  const asm = new ChunkAssembler();
  let out: Packet | null = null;
  for (const part of [...parts].reverse()) out = asm.add(part as Extract<Packet, { t: 'chunk' }>) ?? out;
  assert.deepEqual(out, big);
  const small = encodePacket({ v: 1, t: 'end' });
  assert.equal(small.length, 1);
  assert.deepEqual(decodePacket(small[0]!), { v: 1, t: 'end' });
});

test('snapshot: compressed round trip, smaller than JSON', async () => {
  const d = emptyDoc('lined');
  const p = d.pages[0]!.id;
  for (let i = 0; i < 200; i++) applyOp(d, { k: 'add', p, item: stroke(`t${i}`, 'teacher_1', Array.from({ length: 40 }, (_, j) => 100 + j)) });
  const snap = await encodeSnapshot(d);
  assert.equal(snap.t, 'snap');
  assert.ok(snap.t === 'snap' && snap.z === 1 && snap.doc.length < JSON.stringify(d).length / 3);
  const back = await decodeSnapshot(snap as Extract<Packet, { t: 'snap' }>);
  assert.deepEqual(back, d);
});

test('session: late joiner gets the same board from a snapshot + live ops', async () => {
  const host = new WhiteboardSession(undefined, true);
  const p = host.doc.pages[0]!.id;
  host.apply([{ k: 'add', p, item: stroke('t1') }]);
  const viewer = new WhiteboardSession();
  for (const pk of await host.snapshotPackets()) await viewer.receive(pk);
  assert.ok(viewer.ready);
  const live: Op[] = [{ k: 'pts', p, id: 't1', pts: [5, 5] }];
  host.apply(live);
  for (const pk of opsPackets(live)) await viewer.receive(pk);
  assert.deepEqual(viewer.doc, host.doc);
  const req = await viewer.receive(new TextEncoder().encode(JSON.stringify({ v: 1, t: 'req', to: 'student_1' })));
  assert.deepEqual(req, { v: 1, t: 'req', to: 'student_1' });
});

test('student ops: only own pen strokes are relayed and accepted', () => {
  const ops = sanitizeStudentOps(
    [
      { k: 'add', p: 'p1', item: { k: 'stroke', id: 'sX', by: 'teacher_1', tool: 'pen', c: '#e53935', w: 4, pts: [1, 2] } },
      { k: 'add', p: 'p1', item: { k: 'img', id: 'sI', src: 'data:image/png;base64,AA==', x: 0, y: 0, w: 1, h: 1 } },
      { k: 'clear', p: 'p1' },
      { k: 'pts', p: 'p1', id: 'sX', pts: [3, 4] },
      { k: 'del', p: 'p1', ids: ['tTeacher', 'sX'] },
    ],
    'student_7'
  );
  assert.equal(ops.length, 3);
  assert.equal(ops[0]!.k === 'add' && ops[0]!.item.by, 'student_7');
  assert.deepEqual(ops[2], { k: 'del', p: 'p1', ids: ['sX'] });
  const d = emptyDoc();
  const p = d.pages[0]!.id;
  applyOp(d, { k: 'add', p, item: stroke('sMine', 'student_7') });
  applyOp(d, { k: 'add', p, item: stroke('sOther', 'student_8') });
  assert.ok(studentOpAllowed({ k: 'del', p, ids: ['sMine'] }, 'student_7', d));
  assert.ok(!studentOpAllowed({ k: 'del', p, ids: ['sOther'] }, 'student_7', d));
  assert.ok(!studentOpAllowed({ k: 'pts', p, id: 'sOther', pts: [1, 1] }, 'student_7', d));
  assert.ok(!studentOpAllowed({ k: 'clear', p }, 'student_7', d));
});

test('pdf export: valid header, one page object per page', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = new TextDecoder('latin1').decode(jpegsToPdf([{ jpeg, w: 1920, h: 1080 }, { jpeg, w: 1920, h: 1080 }]));
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, 2);
  assert.ok(pdf.includes('/Count 2'));
  assert.ok(pdf.trimEnd().endsWith('%%EOF'));
});
