import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DRAW_ALLOW_MS } from '../src/lib/drawLogic';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => readFileSync(`src/${p}`, 'utf8');

test('annotation: the teacher turns it on per student from the roster; students cannot ask', () => {
  const room = classroomViewSource();
  assert.match(room, /testId="roster-annotate"/);
  assert.match(room, /`Let \$\{p\.displayName\} annotate the whiteboard`/);
  assert.match(room, /disabled=\{!p\.drawing && !wbOpen\}/);
  assert.match(room, /onClick=\{\(\) => void \(p\.drawing \? revokeDrawing\(p\.id\) : allowDrawing\(p\.id\)\)\}/);
  // The allowed student gets the annotation tools on the board.
  assert.match(room, /canAnnotate=\{myDrawState === 'drawing' && !!state\?\.me\?\.canDraw\}/);
  // No Draw / request button for students.
  const controls = src('components/classroom/Controls.tsx');
  assert.doesNotMatch(controls, /onToggleDraw|Request to draw/);
  assert.doesNotMatch(src('components/classroom/drawActions.ts'), /action: on \? 'request'/);
  // Lasts the class (until the teacher stops it or the board closes), not 3 minutes.
  assert.equal(DRAW_ALLOW_MS, 6 * 60 * 60 * 1000);
});

test('whiteboard: teachers cannot zoom (only scroll); students still can', () => {
  const board = src('lib/whiteboard/WhiteboardBoard.tsx');
  assert.doesNotMatch(board, /aria-label="Zoom in"|aria-label="Zoom out"|aria-label="Fit page"/);
  assert.match(board, /if \(!disableZoom && mode !== 'edit'\) setZp/);
  assert.match(board, /\/\/ Teacher: the wheel \(with or without Ctrl\) only scrolls the long page/);
  assert.match(board, /\/\/ Teacher: two fingers only scroll the long page \(no zoom\)\./);
});

test('permission retry asks the browser straight from the tap', () => {
  const perms = src('lib/permissions.ts');
  const i = perms.indexOf('export function requestPermissionFromTap');
  const body = perms.slice(i, perms.indexOf('\n}\n', i));
  // getUserMedia comes before anything is awaited (the tap must still count).
  assert.ok(body.indexOf('getUserMedia') > 0 && body.indexOf('getUserMedia') < body.indexOf('await'));
  assert.match(body, /afterTap: true/);
  const room = classroomViewSource();
  assert.equal((room.match(/requestPermissionFromTap\('camera'\)/g) || []).length, 2);
  assert.equal((room.match(/requestPermissionFromTap\('microphone'\)/g) || []).length, 2);
});
