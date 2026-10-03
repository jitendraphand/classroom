import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap, sideWindowBox, SIDE_SIZE, type SideKind } from '../src/lib/sideWindowGeometry';

const avail = { left: 0, top: 0, width: 1920, height: 1040 };
const toolbar = { x: 1300, y: 960, w: 380, h: 70 };
const asBox = (b: { left: number; top: number; w: number; h: number }) => ({ x: b.left, y: b.top, w: b.w, h: b.h });

test('side windows open above a toolbar at the bottom, right-aligned with it', () => {
  const chat = sideWindowBox('chat', toolbar, avail);
  assert.equal(chat.left + chat.w, toolbar.x + toolbar.w);
  assert.equal(chat.top + chat.h, toolbar.y - 8);
  assert.equal(boxesOverlap(asBox(chat), toolbar), false);
});

test('chat, roster and videos never overlap each other or the toolbar', () => {
  const kinds: SideKind[] = ['chat', 'roster', 'videos'];
  const boxes = kinds.map((k) => asBox(sideWindowBox(k, toolbar, avail)));
  for (const b of boxes) assert.equal(boxesOverlap(b, toolbar), false);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.equal(boxesOverlap(boxes[i], boxes[j]), false, `${kinds[i]} vs ${kinds[j]}`);
});

test('a toolbar at the top puts side windows below it', () => {
  const top = { x: 600, y: 10, w: 380, h: 70 };
  const r = sideWindowBox('roster', top, avail);
  assert.ok(r.top >= top.y + top.h);
});

test('windows stay inside the available area (secondary screen at negative x)', () => {
  const second = { left: -1280, top: 0, width: 1280, height: 984 };
  const tb = { x: -1270, y: 900, w: 300, h: 60 };
  for (const k of ['chat', 'roster', 'videos'] as SideKind[]) {
    const b = sideWindowBox(k, tb, second);
    assert.ok(b.left >= second.left && b.left + b.w <= second.left + second.width);
    assert.ok(b.top >= second.top && b.top + b.h <= second.top + second.height);
  }
});

test('unknown toolbar position: bottom-right of the screen, default size', () => {
  const b = sideWindowBox('chat', null, avail);
  assert.equal(b.w, SIDE_SIZE.chat.w);
  assert.equal(b.left + b.w, 1920 - 8);
  assert.equal(b.top + b.h, 1040 - 8);
});

test('toolbar window fits its row: no extra width or height', async () => {
  const { toolbarInnerSize } = await import('../src/lib/sideWindowGeometry');
  assert.deepEqual(toolbarInnerSize({ w: 352.4, h: 36 }, { panel: false }), { w: 355, h: 36 });
  assert.equal(toolbarInnerSize({ w: 352, h: 300 }, { panel: false }).h, 64);
  assert.equal(toolbarInnerSize({ w: 352, h: 300 }, { panel: true }).h, 300);
  assert.equal(toolbarInnerSize({ w: 2000, h: 36 }, { panel: false }).w, 980);
});
