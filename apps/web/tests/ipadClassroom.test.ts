import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAppleTouchDevice, isIPhoneUA } from '../src/lib/focusStatus';
import { createTypingHold, isEditableTarget } from '../src/lib/fullscreenTyping';

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

test('fullscreen stays on iPad; typing leaves it first, the next tap brings it back', () => {
  const focus = readFileSync('src/components/classroom/useStudentFocus.ts', 'utf8');
  const i = focus.indexOf('export function fullscreenSupported()');
  assert.doesNotMatch(focus.slice(i, focus.indexOf('\n}', i)), /isAppleTouchDevice/); // not switched off
  for (const f of ['src/components/classroom/useStudentFocus.ts', 'src/components/classroom/useTeacherFullscreen.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /installTypingGuard\(document, \(\) => \{/, f);
    assert.match(src, /typingHold\.active\(\)/, f);
  }
  const teacher = readFileSync('src/components/classroom/useTeacherFullscreen.ts', 'utf8');
  assert.match(teacher, /permissionGrace: permGrace \|\| typing/); // no cover while typing
  assert.match(teacher, /setCoverDismissed\(true\);\n\s+void exitFullscreenIfActive\(\)/); // small bar after
  assert.match(teacher, /if \(appleTouch && isEditableTarget\(target\)\) return;/);
  const css = readFileSync('src/app/globals.css', 'utf8');
  assert.match(css, /html,\nbody \{\n  overscroll-behavior: none;/);
  assert.match(css, /\.overflow-y-auto,[\s\S]*?overscroll-behavior: contain;/);
});

test('typing hold: on while a text field has focus, ends after a short tail', () => {
  let fire: (() => void) | null = null;
  const h = createTypingHold({ tailMs: 800, setTimer: (fn) => ((fire = fn), 1), clearTimer: () => (fire = null) });
  let changes = 0;
  h.subscribe(() => changes++);
  assert.equal(h.active(), false);
  h.start();
  assert.equal(h.active(), true);
  h.stop();
  assert.equal(h.active(), true); // keyboard closing / the Send tap
  h.start(); // straight into another field: no gap
  assert.equal(fire, null);
  h.stop();
  (fire as unknown as () => void)();
  assert.equal(h.active(), false);
  assert.equal(changes, 2);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget(null), false);
});

test('whiteboard: no text selection or iOS long-press menu while writing', () => {
  const board = readFileSync('src/lib/whiteboard/WhiteboardBoard.tsx', 'utf8');
  assert.match(board, /const NO_SELECT: CSSProperties = \{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' \}/);
  assert.match(board, /\.\.\.NO_SELECT, \.\.\.style \}\} data-whiteboard=\{mode\} onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(board, /doc\.addEventListener\('selectstart', block\)/);
  assert.match(board, /userSelect: 'text', WebkitUserSelect: 'text'/); // the text tool still works
});
