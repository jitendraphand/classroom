import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('entire-screen share exposes interactive teacher ink without a recursive video preview', () => {
  const src = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  const pad = src.slice(src.indexOf('function EntireShareDrawingPreview'), src.indexOf('function EntireScreenShareCard'));
  assert.match(pad, /TeacherInkOverlay interactive/);
  assert.match(pad, /Annotate entire-screen share/);
  assert.match(pad, /capture.width \/ capture.height/);
  assert.doesNotMatch(pad, /<video|<VideoTrack/);
});
