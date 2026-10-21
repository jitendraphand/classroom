import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VIDEO_PANEL_MARGIN,
  VIDEO_PANEL_MIN_H,
  VIDEO_PANEL_MIN_W,
  WB_TOOL_CLEAR_PX,
  WB_TOOL_COLUMN_PX,
  WB_VIDEO_MAX_AREA,
  clampFloat,
  clampVideoPanelSize,
  clampWhiteboardFloat,
  compactWhiteboardVideo,
  isDrag,
  parseStoredPos,
  parseStoredSize,
  placeWhiteboardVideo,
  shareControlsPlacement,
  showLocalSharePreview,
  tilesInPane,
  videoPanelSizeFromDrag,
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

test('video panel size clamps to a usable tile and to the free viewport', () => {
  assert.equal(VIDEO_PANEL_MIN_W, 180);
  assert.equal(VIDEO_PANEL_MIN_H, 132);
  assert.equal(VIDEO_PANEL_MARGIN, 8);
  const roomy = { w: 1000, h: 800 };
  assert.deepEqual(clampVideoPanelSize({ w: 10, h: 10 }, roomy), { w: 180, h: 132 });
  assert.deepEqual(clampVideoPanelSize({ w: 5000, h: 5000 }, roomy), { w: 984, h: 784 });
  assert.deepEqual(clampVideoPanelSize({ w: NaN, h: 0 }, roomy), { w: 180, h: 132 });
  assert.deepEqual(clampVideoPanelSize({ w: -4, h: Number.POSITIVE_INFINITY }, roomy), { w: 180, h: 132 });

  const inset = clampVideoPanelSize({ w: 900, h: 700 }, roomy, {
    insets: { left: 62, top: 90, right: 0, bottom: 40 },
  });
  assert.deepEqual(inset, { w: 900, h: 654 });

  const tiny = clampVideoPanelSize({ w: 50, h: 50 }, { w: 100, h: 80 });
  assert.deepEqual(tiny, { w: 84, h: 64 });
  assert.ok(tiny.w < VIDEO_PANEL_MIN_W && tiny.h < VIDEO_PANEL_MIN_H);

  const once = clampVideoPanelSize({ w: 9999, h: 10 }, { w: 640, h: 480 }, { insets: { left: 62, top: 48 } });
  assert.deepEqual(clampVideoPanelSize(once, { w: 640, h: 480 }, { insets: { left: 62, top: 48 } }), once);
});

test('a pointer drag grows from the start size and then clamps', () => {
  const start = { w: 200, h: 160 };
  assert.deepEqual(videoPanelSizeFromDrag(start, 40, -10, { w: 800, h: 600 }), { w: 240, h: 150 });
  assert.deepEqual(videoPanelSizeFromDrag(start, Number.NaN, 20, { w: 800, h: 600 }), { w: 200, h: 180 });
  const huge = videoPanelSizeFromDrag(start, 5000, 5000, { w: 400, h: 300 });
  assert.deepEqual(huge, clampVideoPanelSize({ w: 5200, h: 5160 }, { w: 400, h: 300 }));
  assert.deepEqual(videoPanelSizeFromDrag(huge, 0, 0, { w: 400, h: 300 }), huge);
});

test('the floating video handle resizes with pointer capture in whiteboard and share', () => {
  const room = readFileSync(new URL('../src/components/classroom/ClassroomRoom.tsx', import.meta.url), 'utf8');
  assert.match(room, /data-testid="video-panel-resize"/);
  assert.match(room, /aria-label="Resize videos"/);
  assert.match(room, /onPointerDown=\{/);
  assert.match(room, /onPointerMove=\{/);
  assert.match(room, /onPointerUp=\{finishResize\}/);
  assert.match(room, /onPointerCancel=\{finishResize\}/);
  assert.match(room, /onLostPointerCapture=\{finishResize\}/);
  assert.match(room, /setPointerCapture\(e\.pointerId\)/);
  assert.match(room, /class_panel_wb_manual/);
  assert.match(room, /class_panel_share_manual/);
  assert.match(room, /setManualSize\(null\)/);
  assert.match(room, /allowResize = !isMin && !embedLayout && \(whiteboard \|\| sharing \|\| floating \|\| portal\)/);
  const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.peers-float-resize \{[\s\S]*touch-action: none;/);
});
