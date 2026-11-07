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
