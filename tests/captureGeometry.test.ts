import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fitEven, framePoolSize, physicalRect, visibleFraction } from '../src/shared/captureGeometry';
import { regionFrameRect } from '../src/shared/apiModel';
import { cssPointerToNormalized } from '../src/shared/annotateOverlay';

const MAX = { w: 1280, h: 720 };
const SCALES = [1, 1.25, 1.5, 1.75, 2];
const MONITORS = [
  { name: '1080p 16:9', w: 1920, h: 1080 },
  { name: '1366x768', w: 1366, h: 768 },
  { name: '16:10', w: 1920, h: 1200 },
  { name: '2560x1600', w: 2560, h: 1600 },
  { name: '4K', w: 3840, h: 2160 },
  { name: 'ultrawide', w: 3440, h: 1440 },
  { name: 'super ultrawide', w: 5120, h: 1440 },
  { name: 'portrait', w: 1080, h: 1920 },
  { name: 'small', w: 1024, h: 576 },
];

test('whole-screen share sends the entire monitor, aspect kept, at every scale factor and shape', () => {
  for (const m of MONITORS) {
    for (const s of SCALES) {
      // Electron reports DIPs; the monitor (and the WGC item) is physical.
      const dip = { x: 0, y: 0, w: Math.round(m.w / s), h: Math.round(m.h / s) };
      const phys = physicalRect(dip, s);
      assert.ok(Math.abs(phys.w - m.w) <= 2 && Math.abs(phys.h - m.h) <= 2, `${m.name}@${s}`);
      const pool = framePoolSize({ w: m.w, h: m.h });
      assert.deepEqual(visibleFraction({ w: m.w, h: m.h }, pool), { w: 1, h: 1 }, `${m.name}@${s}: nothing cropped`);
      const out = fitEven({ w: m.w, h: m.h }, MAX);
      assert.ok(out.w <= MAX.w && out.h <= MAX.h, `${m.name}: fits`);
      assert.ok(out.w % 2 === 0 && out.h % 2 === 0);
      const err = Math.abs(out.w / out.h - m.w / m.h) / (m.w / m.h);
      assert.ok(err < 0.01, `${m.name}: aspect ${out.w}x${out.h}`);
      assert.ok(out.w === MAX.w || out.h === MAX.h || (m.w <= MAX.w && m.h <= MAX.h), `${m.name}: fills one side`);
    }
  }
});

test('the old pool-at-output-size behaviour is the reported crop (regression guard)', () => {
  // 1920x1080 monitor, pool 1280x720 → students saw the top-left 2/3 only.
  assert.deepEqual(visibleFraction({ w: 1920, h: 1080 }, { w: 1280, h: 720 }), { w: 1280 / 1920, h: 720 / 1080 });
  const c = fs.readFileSync(path.join(__dirname, '..', 'native', 'affinity-helper.c'), 'utf8');
  assert.match(c, /poolSize\.Width = itemSize\.Width;\s*poolSize\.Height = itemSize\.Height;/);
  assert.doesNotMatch(c, /poolSize\.Width = outW;/);
  assert.match(c, /cs\.Width != poolSize\.Width \|\| cs\.Height != poolSize\.Height/);
  assert.match(c, /SetProcessDpiAwarenessContext/);
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'native', 'helper.manifest'), 'utf8');
  assert.match(manifest, /PerMonitorV2/);
});

test('region shares map DIP rectangles onto the whole-monitor frame at any scale and offset', () => {
  for (const s of SCALES) {
    // Second monitor to the right of a 1920-DIP primary, and one above-left (negative).
    for (const display of [
      { x: 1920, y: 0, w: Math.round(2560 / s), h: Math.round(1440 / s) },
      { x: -1280, y: -200, w: Math.round(1920 / s), h: Math.round(1080 / s) },
    ]) {
      const frame = fitEven({ w: Math.round(display.w * s), h: Math.round(display.h * s) }, MAX);
      const whole = regionFrameRect(display, display, { width: frame.w, height: frame.h });
      assert.deepEqual(whole, { sx: 0, sy: 0, sw: frame.w, sh: frame.h }, `whole display @${s}`);
      const right = regionFrameRect(
        { x: display.x + display.w / 2, y: display.y + display.h / 2, w: display.w / 2, h: display.h / 2 },
        display,
        { width: frame.w, height: frame.h }
      )!;
      assert.ok(Math.abs(right.sx - frame.w / 2) <= 1 && Math.abs(right.sy - frame.h / 2) <= 1, `quadrant @${s}`);
      assert.ok(right.sx + right.sw <= frame.w && right.sy + right.sh <= frame.h);
    }
  }
});

test('overlay ink coordinates are monitor fractions, so they land on the scaled frame at any scale', () => {
  for (const s of SCALES) {
    const dip = { x: 1920, y: 0, w: Math.round(2560 / s), h: Math.round(1440 / s) };
    const phys = { x: Math.round(1920 * 1), y: 0, widthPx: Math.round(dip.w * s), heightPx: Math.round(dip.h * s) };
    const br = cssPointerToNormalized({ x: dip.w, y: dip.h }, dip, s, phys);
    const mid = cssPointerToNormalized({ x: dip.w / 2, y: dip.h / 2 }, dip, s, phys);
    assert.ok(br && mid);
    assert.ok(Math.abs(br![0] - 1) < 0.01 && Math.abs(br![1] - 1) < 0.01, `corner @${s}: ${br}`);
    assert.ok(Math.abs(mid![0] - 0.5) < 0.01 && Math.abs(mid![1] - 0.5) < 0.01, `centre @${s}: ${mid}`);
  }
});
