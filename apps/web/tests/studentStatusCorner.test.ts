import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chatBottomReserve, STATUS_ROW_RESERVE_PX, studentChatBox } from '../src/hooks/useStudentLayout';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

// Nov 22: "Teacher is in the room" and the class-info "i" moved to the lower-left corner.
test('student status + class info sit in the lower-left corner, info opens upward', () => {
  const room = read('components/classroom/ClassroomRoom.tsx');
  const css = read('app/globals.css');
  const info = read('components/classroom/ClassInfoButton.tsx');
  assert.match(room, /className="stage-bottom-left"/);
  assert.doesNotMatch(room, /stage-top-left/);
  assert.match(room, /<ClassInfoButton\s+placement="up"/);
  assert.match(room, /ref=\{studentControlsRef\}/);
  assert.match(info, /placement === 'up' \? 'bottom-10/);
  const corner = css.slice(css.indexOf('.stage-bottom-left {'));
  assert.match(corner, /bottom: max\(0\.75rem, env\(safe-area-inset-bottom/);
  assert.match(corner, /max-width: calc\(100vw - 6rem\)/); // clears the right-edge controls
  // Portrait phone: above the bottom control row (measured height).
  assert.match(css, /bottom: calc\(var\(--student-controls-h, 112px\) \+ 0\.5rem\)/);
});

test('an open student chat stays above the lower-left status row', () => {
  for (const [w, h] of [[1280, 800], [1920, 1080], [844, 390], [390, 844], [360, 740], [1024, 768]] as const) {
    const b = studentChatBox(w, h);
    assert.ok(chatBottomReserve(w, h) >= STATUS_ROW_RESERVE_PX + 8, `${w}x${h}: reserve`);
    assert.ok(b.y + b.height <= h - chatBottomReserve(w, h) + 0.5 || b.y === 8, `${w}x${h}: chat bottom clears the row`);
  }
});

test("class info 'up' anchors to the corner row, not the 'i'", () => {
  const info = read('components/classroom/ClassInfoButton.tsx');
  assert.match(info, /placement === 'up' \? undefined : 'relative'/);
});
