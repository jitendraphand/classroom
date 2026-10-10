import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dockTileSize, videoGrid } from '../src/shared/classLogic';
import { studentStrokesHit, withoutStrokes } from '../src/shared/studentErase';
import { compositeInkLayer, inkedPixels, type InkLayer } from '../src/shared/inkLayer';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('docked grid uses the floating window arrangement for 2/4/6', () => {
  for (const n of [2, 4, 6] as const) assert.deepEqual(videoGrid(n, 'dock'), videoGrid(n, 'share'));
});

test('docked tiles are compact 16:9 and fit the box', () => {
  for (const n of [2, 4, 6] as const) {
    for (const box of [{ w: 400, h: 900 }, { w: 1200, h: 300 }, { w: 640, h: 360 }]) {
      const t = dockTileSize(box, n);
      assert.ok(Math.abs(t.tileW / t.tileH - 16 / 9) < 0.05, 'aspect');
      assert.ok(t.cols * t.tileW + (t.cols - 1) * 4 <= box.w + 1, 'width fits');
      assert.ok(t.rows * t.tileH + (t.rows - 1) * 4 <= box.h + 1, 'height fits');
    }
  }
  // A tall narrow column no longer makes full-width strips 4 high.
  assert.equal(dockTileSize({ w: 400, h: 900 }, 4).cols, 2);
});

test('teacher eraser hits student strokes through the region rect', () => {
  const strokes = [
    { id: 'a', pts: [0.1, 0.1, 0.9, 0.1] },
    { id: 'b', pts: [0.5, 0.9] },
  ];
  const full = { x: 0, y: 0, w: 1, h: 1 };
  assert.deepEqual(studentStrokesHit(strokes, full, [0.5, 0.1], 16 / 9), ['a']);
  assert.deepEqual(studentStrokesHit(strokes, full, [0.5, 0.9], 16 / 9), ['b']);
  assert.deepEqual(studentStrokesHit(strokes, full, [0.5, 0.5], 16 / 9), []);
  // Region share on the right half: picture x 0.5 → monitor x 0.75.
  const region = { x: 0.5, y: 0, w: 0.5, h: 1 };
  assert.deepEqual(studentStrokesHit(strokes, region, [0.75, 0.9], 16 / 9), ['b']);
  assert.deepEqual(studentStrokesHit(strokes, region, [0.5, 0.9], 16 / 9), []);
  assert.deepEqual(withoutStrokes([{ id: 'a' }, { id: 'b' }], ['a']), [{ id: 'b' }]);
});

test('erase and clear flow overlay/tools → main → class window → /draw', () => {
  assert.match(src('renderer/annotate.ts'), /eraseStudents\(p\)/);
  assert.match(src('main/main.ts'), /'student-ink-erase'[\s\S]*event\.sender !== overlay\.webContents/);
  assert.match(src('main/main.ts'), /'student-ink-clear'[\s\S]*event\.sender !== tools\.webContents/);
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /createEraseBatcher/);
  assert.match(cs, /edit\.clear[\s\S]*action: 'clear'/);
  const tools = src('renderer/tools.tsx');
  assert.match(tools, /Clear student drawings/);
  assert.match(tools, /Clear all/);
});

test('video mode is manual only: no auto-detect, starts off', () => {
  const cs = src('renderer/classSession.ts');
  assert.doesNotMatch(cs, /nextVideoMode|startVideoWatch\(|changedFrames/);
  assert.match(cs, /videoMode: VideoModeState = \{ \.\.\.VIDEO_MODE_OFF \}/);
  assert.match(cs, /'toggle-video-mode'/);
});

test('ink composite walks only inked pixels and matches a full blend', () => {
  const fw = 8;
  const fh = 4;
  const rgba = new Uint8Array(4 * 2 * 4);
  rgba.set([255, 0, 0, 255], 0); // opaque
  rgba.set([0, 0, 255, 128], 4 * 5); // half
  const layer: InkLayer = { fw, fh, x: 3, y: 1, w: 4, h: 2, rgba };
  assert.deepEqual([...inkedPixels(layer)], [0, 5]);
  const frame = new Uint8Array(fw * fh * 4).fill(100);
  assert.ok(compositeInkLayer(frame, fw, fh, layer));
  const at = (x: number, y: number) => [...frame.slice((y * fw + x) * 4, (y * fw + x) * 4 + 3)];
  assert.deepEqual(at(3, 1), [255, 0, 0]);
  assert.deepEqual(at(4, 2), [Math.floor((0 * 128 + 100 * 127 + 127) / 255), Math.floor((100 * 127 + 127) / 255), Math.floor((255 * 128 + 100 * 127 + 127) / 255)]);
  assert.deepEqual(at(5, 1), [100, 100, 100]);
});
