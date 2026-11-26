import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('teacher whiteboard: notices float bottom-right; the board never moves', () => {
  const src = readFileSync('src/components/classroom/Whiteboard.tsx', 'utf8');
  // Fixed top edge: no measuring of header height, no shifting.
  assert.match(src, /style=\{\{ right: MEETING_BAR_PX, top: 0 \}\}/);
  assert.doesNotMatch(src, /chromeBottom/);
  const room = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  assert.ok(room.indexOf('data-whiteboard-chrome') < room.indexOf('{hudNotice && isTeacher'));
  assert.match(room, /className=\{isTeacher && wbOpen \? 'wb-notice-stack' : 'relative z-\[60\] shrink-0'\}/);
  assert.match(room, /data-float-bound=\{isTeacher && wbOpen \? undefined : 'top'\}/);
  const css = readFileSync('src/app/globals.css', 'utf8');
  assert.match(css, /\.wb-notice-stack \{\s*position: fixed;\s*bottom: 16px;/);
});
