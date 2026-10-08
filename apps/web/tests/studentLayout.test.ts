import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactViewport, studentChatBox } from '../src/hooks/useStudentLayout';

const DEVICES: [string, number, number][] = [
  ['iPhone 14 landscape', 844, 390],
  ['iPhone 14 portrait', 390, 844],
  ['Pixel 7 landscape', 915, 412],
  ['iPad landscape', 1180, 820],
  ['Galaxy Tab S8 landscape', 1280, 800],
  ['Windows laptop', 1366, 768],
  ['MacBook', 1440, 900],
  ['Desktop 1080p', 1920, 1080],
];

test('one chat box rule for every device: bottom-left, inside the viewport, clear of the right controls', () => {
  for (const [name, w, h] of DEVICES) {
    const b = studentChatBox(w, h);
    assert.equal(b.x, 8, name);
    assert.ok(b.y + b.height <= h - 8 || b.y === 8, `${name}: bottom inside`);
    assert.ok(b.x + b.width <= w - 72, `${name}: leaves the right control panel free`);
    assert.ok(b.width * b.height <= w * h * 0.25, `${name}: covers at most a quarter of the screen`);
  }
});

test('the chat box only scales: same corner, bigger on bigger screens', () => {
  const phone = studentChatBox(844, 390);
  const desk = studentChatBox(1920, 1080);
  assert.ok(desk.width >= phone.width && desk.height >= phone.height);
  assert.equal(desk.width, 340);
  assert.equal(desk.height, 420);
});

test('compact text is a size rule, not a device rule', () => {
  assert.equal(compactViewport(844, 390), true);
  assert.equal(compactViewport(390, 844), true);
  assert.equal(compactViewport(1280, 800), false);
});
