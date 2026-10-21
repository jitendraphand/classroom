import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WB_TOOL_CLEAR_PX,
  WB_TOOL_COLUMN_PX,
  WB_VIDEO_MAX_AREA,
  clampFloat,
  clampWhiteboardFloat,
  compactWhiteboardVideo,
  isDrag,
  parseStoredPos,
  parseStoredSize,
  placeWhiteboardVideo,
  shareControlsPlacement,
  showLocalSharePreview,
  tilesInPane,
  whiteboardShareDockPos,
} from '../src/lib/floatGeometry';

const vp = { w: 800, h: 400 };

test('clampFloat keeps a panel inside the viewport and below the header', () => {
  const insets = { top: 90, bottom: 60 };
  assert.deepEqual(clampFloat({ x: -50, y: 0 }, { w: 200, h: 100 }, vp, insets), { x: 4, y: 94 });
  assert.deepEqual(clampFloat({ x: 900, y: 900 }, { w: 200, h: 100 }, vp, insets), { x: 596, y: 236 });
  assert.deepEqual(clampFloat({ x: 300, y: 150 }, { w: 200, h: 100 }, vp, insets), { x: 300, y: 150 });
});

test('a panel taller than the free area is pinned to the top so its header stays reachable', () => {
  const p = clampFloat({ x: 10, y: 300 }, { w: 300, h: 600 }, vp, { top: 90, bottom: 60 });
  assert.equal(p.y, 94);
});

test('clampFloat survives NaN input', () => {
  assert.deepEqual(clampFloat({ x: NaN, y: NaN }, { w: 10, h: 10 }, vp), { x: 4, y: 4 });
});

test('isDrag needs a 4px move so taps stay taps', () => {
  assert.equal(isDrag(2, 2), false);
  assert.equal(isDrag(3, 3), true);
});

test('parseStoredPos rejects junk', () => {
  assert.deepEqual(parseStoredPos('{"x":10,"y":20}'), { x: 10, y: 20 });
  assert.equal(parseStoredPos('{"x":"a"}'), null);
  assert.equal(parseStoredPos('nope'), null);
  assert.equal(parseStoredPos(null), null);
});

test('entire-screen capture keeps the share controls in the page', () => {
  assert.equal(shareControlsPlacement('monitor'), 'inline');
  assert.equal(shareControlsPlacement('window'), 'floating');
  assert.equal(shareControlsPlacement('browser'), 'floating');
  // Unknown surface fails closed.
  assert.equal(shareControlsPlacement(''), 'inline');
  assert.equal(shareControlsPlacement(undefined), 'inline');
});

test('compact whiteboard video sits bottom-right, clear of the tools, at most 20% of the board', () => {
  const board = { x: 0, y: 64, w: 1280, h: 640 };
  const box = compactWhiteboardVideo(board);
  assert.equal(WB_TOOL_COLUMN_PX, 54);
  const boardSrc = readFileSync(new URL('../src/lib/whiteboard/WhiteboardBoard.tsx', import.meta.url), 'utf8');
  assert.match(boardSrc, /const barW = 54;/);
  assert.ok(box.x >= board.x + WB_TOOL_CLEAR_PX, `x ${box.x} covers the tool column`);
  assert.ok(box.x + box.w <= board.x + board.w, 'past the right edge');
  assert.ok(box.y + box.h <= board.y + board.h, 'past the bottom edge');
  assert.ok(box.w * box.h <= board.w * board.h * WB_VIDEO_MAX_AREA + 1, `area ${box.w * box.h}`);
  assert.ok(box.x > board.w / 2, 'not docked to the right');
  assert.ok(box.y > board.y + board.h / 2, 'not docked to the bottom');
  const tiles = tilesInPane(box.w, box.h, 1, 2);
  assert.ok(tiles.tileW >= 48 && tiles.tileH >= 27);
  assert.ok(tiles.tileW <= box.w && tiles.tileH * 2 <= box.h);
});

test('a saved whiteboard video box cannot come back covering the tools or the board', () => {
  const board = { x: 0, y: 40, w: 1000, h: 700 };
  const placed = placeWhiteboardVideo({ x: 0, y: 0 }, { w: 4000, h: 3000 }, board);
  assert.ok(placed.x >= WB_TOOL_CLEAR_PX);
  assert.ok(placed.w * placed.h <= board.w * board.h * WB_VIDEO_MAX_AREA + 1);
  assert.ok(placed.x + placed.w <= board.w);
  const kept = clampWhiteboardFloat({ x: 400, y: 200, w: 160, h: 120 }, board, { maxAreaFraction: WB_VIDEO_MAX_AREA });
  assert.ok(kept.x >= WB_TOOL_CLEAR_PX);
  assert.ok(kept.w <= 160 && kept.h <= 120);
});

test('whiteboard share dock defaults to the top centre, clear of the tool column', () => {
  const pos = whiteboardShareDockPos({ w: 320, h: 48 }, { w: 1440, h: 900 }, 72);
  assert.ok(pos.x >= WB_TOOL_CLEAR_PX);
  assert.ok(Math.abs(pos.x + 160 - 720) < 80, `expected near centre, got ${pos.x}`);
  assert.ok(pos.y >= 72);
  const narrow = whiteboardShareDockPos({ w: 300, h: 40 }, { w: 320, h: 640 }, 48);
  assert.ok(narrow.x >= WB_TOOL_CLEAR_PX);
});

test('parseStoredSize rejects junk and non-positive sizes', () => {
  assert.deepEqual(parseStoredSize('{"w":180,"h":220}'), { w: 180, h: 220 });
  assert.equal(parseStoredSize('{"w":0,"h":10}'), null);
  assert.equal(parseStoredSize('{"w":-1,"h":10}'), null);
  assert.equal(parseStoredSize('nope'), null);
  assert.equal(parseStoredSize(null), null);
});

test('teacher stage previews only window/tab shares (no recursive tunnel)', () => {
  assert.equal(showLocalSharePreview('window'), true);
  assert.equal(showLocalSharePreview('browser'), true);
  assert.equal(showLocalSharePreview('monitor'), false);
  assert.equal(showLocalSharePreview(''), false);
  assert.equal(showLocalSharePreview(undefined), false);
});
