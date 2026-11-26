import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('joining students see inline fetch errors and never a "class full" notice', () => {
  const src = readFileSync('src/app/join/[code]/page.tsx', 'utf8');
  assert.doesNotMatch(src, /classFull|class is full|seat becomes available/i);
  assert.match(src, /role="alert">\{error\}/);
});
