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

test("teacher's own drawing pad is not labelled 'Student drawing' (Nov 7 trial)", async () => {
  const { drawPadLabel } = await import('../src/lib/drawLogic');
  assert.equal(drawPadLabel(null), 'Your drawing pad');
  assert.equal(drawPadLabel(''), 'Your drawing pad');
  assert.equal(drawPadLabel('Asha'), 'Your drawing pad · Asha is drawing too');
  assert.equal(drawPadLabel('Asha, Ravi'), 'Your drawing pad · Asha, Ravi are drawing too');
  const room = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  const pad = room.slice(room.indexOf('function EntireShareDrawingPreview'), room.indexOf('share-draw-actions'));
  assert.match(pad, /drawPadLabel\(d\.holder\?\.name\)/);
  assert.doesNotMatch(pad, /'Student drawing'/);
});
