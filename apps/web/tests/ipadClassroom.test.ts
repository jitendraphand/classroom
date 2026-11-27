import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAppleTouchDevice, isIPhoneUA } from '../src/lib/focusStatus';

const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const IPAD_MOBILE_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

test('iPad and iPhone are detected (iPadOS reports a Mac UA; told apart by touch)', () => {
  assert.equal(isAppleTouchDevice(IPAD_DESKTOP_UA, 5), true);
  assert.equal(isAppleTouchDevice(IPAD_MOBILE_UA, 5), true);
  assert.equal(isAppleTouchDevice(IPHONE_UA, 5), true);
  assert.equal(isAppleTouchDevice(IPAD_DESKTOP_UA, 0), false); // a real Mac
  assert.equal(isAppleTouchDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131', 10), false);
  assert.equal(isIPhoneUA(IPAD_DESKTOP_UA), false); // the iPhone-only hint stays iPhone-only
});

test('no Fullscreen API on iPad/iPhone: typing and list swipes kept exiting it', () => {
  const focus = readFileSync('src/components/classroom/useStudentFocus.ts', 'utf8');
  const i = focus.indexOf('export function fullscreenSupported()');
  const body = focus.slice(i, focus.indexOf('\n}', i));
  assert.match(body, /isAppleTouchDevice\(navigator\.userAgent \|\| '', navigator\.maxTouchPoints \|\| 0\)\) return false/);
  // The teacher gate uses the same check.
  assert.match(readFileSync('src/components/classroom/useTeacherFullscreen.ts', 'utf8'), /fullscreenSupported/);
});

test('whiteboard: no text selection or iOS long-press menu while writing', () => {
  const board = readFileSync('src/lib/whiteboard/WhiteboardBoard.tsx', 'utf8');
  assert.match(board, /const NO_SELECT: CSSProperties = \{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' \}/);
  assert.match(board, /\.\.\.NO_SELECT, \.\.\.style \}\} data-whiteboard=\{mode\} onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(board, /doc\.addEventListener\('selectstart', block\)/);
  assert.match(board, /userSelect: 'text', WebkitUserSelect: 'text'/); // the text tool still works
});
