import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('mic options reserve their own hit target beside the mic, not over Unmute', () => {
  const options = readFileSync('src/components/classroom/MicOptions.tsx', 'utf8');
  const controls = readFileSync('src/components/classroom/Controls.tsx', 'utf8');
  assert.match(options, /ref=\{box\} className="relative z-\[5\] inline-flex shrink-0"/);
  assert.doesNotMatch(options, /-bottom-0\.5 -right-1/);
  assert.match(controls, /inline-flex items-center gap-1/);
});

import { placePopover } from '../src/lib/popoverPlacement';

const VP = { width: 1280, height: 720 };
const inside = (r: { left: number; top: number }, size: { width: number; height: number }) =>
  r.left >= 0 && r.top >= 0 && r.left + size.width <= VP.width && r.top + size.height <= VP.height;

test('mic popover: caret near the top-right corner (Nov 7 trial, 1280x720) stays fully on screen', () => {
  const size = { width: 288, height: 230 };
  // Caret at the top-right: opening above, centred, put the panel at y<0 and past the right edge.
  const r = placePopover({ anchor: { left: 1230, top: 12, width: 24, height: 24 }, size, viewport: VP });
  assert.equal(r.side, 'below', 'flips below when there is no room above');
  assert.ok(inside(r, size), JSON.stringify(r));
  assert.ok(r.left + size.width <= 1280 - 8, 'shifted left inside the margin');
});

test('mic popover: bottom bar keeps the usual above-centred placement', () => {
  const size = { width: 288, height: 230 };
  const r = placePopover({ anchor: { left: 628, top: 660, width: 24, height: 24 }, size, viewport: VP });
  assert.equal(r.side, 'above');
  assert.equal(r.left, 628 + 12 - 144);
  assert.equal(r.top, 660 - 8 - 230);
});

test('mic popover: left edge shifts right, and a too-tall panel scrolls', () => {
  const r = placePopover({ anchor: { left: 0, top: 600, width: 24, height: 24 }, size: { width: 288, height: 200 }, viewport: VP });
  assert.equal(r.left, 8);
  const tall = placePopover({ anchor: { left: 600, top: 300, width: 24, height: 24 }, size: { width: 288, height: 900 }, viewport: VP });
  assert.equal(tall.maxHeight, 720 - 16);
  assert.equal(tall.top, 8);
});

test('mic options panel is placed by placePopover, not a fixed bottom/centre offset', () => {
  const options = readFileSync('src/components/classroom/MicOptions.tsx', 'utf8');
  assert.match(options, /placePopover\(/);
  assert.doesNotMatch(options, /absolute bottom-7 left-1\/2/);
});
