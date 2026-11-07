import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('whiteboard reserves dynamic header and notice height above its tools', () => {
  const src = readFileSync('src/components/classroom/Whiteboard.tsx', 'utf8');
  assert.match(src, /new ResizeObserver\(measure\)/);
  assert.match(src, /observer.observe\(chrome\)/);
  assert.match(src, /top: chromeBottom/);
  const room = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  assert.ok(room.indexOf('data-whiteboard-chrome') < room.indexOf('{hudNotice && isTeacher'));
  assert.match(room, /data-whiteboard-chrome data-float-bound="top"/);
});
