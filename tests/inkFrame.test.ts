import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnShapesIntoFrame } from '../src/shared/inkFrame';
import { inspectArrow } from '../src/shared/captureScenario';
import type { AnnotShape } from '../src/shared/annotateOverlay';

function white(w: number, h: number): Buffer {
  const rgba = Buffer.alloc(w * h * 4);
  rgba.fill(255);
  return rgba;
}

const arrow: AnnotShape = {
  id: 'capture-test-arrow',
  type: 'arrow',
  points: [
    [0.1, 0.5],
    [0.9, 0.5],
  ],
  color: '#ff0000',
  width: 14,
  opacity: 1,
  text: '',
  timestamp: 0,
};

test('a burned arrow is red along the shaft and a second burn does not change those pixels', () => {
  const w = 200;
  const h = 80;
  const ground = { width: w, height: h, rgba: white(w, h) };
  const liveRgba = white(w, h);
  const monitor = { scale: 1, monitorW: w, monitorH: h };
  burnShapesIntoFrame(liveRgba, w, h, [arrow], monitor);
  const samples: Array<[number, number]> = [];
  for (let i = 0; i < 24; i++) samples.push([20 + (160 * i) / 23, 40]);
  const verdict = inspectArrow(ground, { width: w, height: h, rgba: liveRgba }, samples);
  assert.equal(verdict.visible, true, `hit=${verdict.hit} considered=${verdict.considered}`);
  const before = Buffer.from(liveRgba);
  burnShapesIntoFrame(liveRgba, w, h, [arrow], monitor);
  assert.ok(before.equals(liveRgba));
});
