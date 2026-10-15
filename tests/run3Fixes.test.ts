import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledShareNotice } from '../src/shared/session';
import { fitToolbar, movedBounds, stableNatural } from '../src/shared/toolbarLayout';
import { SCREEN_SHARE, SIDECAR_HELPER_FPS, VIDEO_MODE_SHARE } from '../src/shared/capture';
import { parseRoomState, adhocBody } from '../src/shared/apiModel';

const P = 'Resuming your screen share…';

test('"Resuming your screen share…" hides once the share is back', () => {
  assert.equal(settledShareNotice(P, P, true), '');
  assert.match(settledShareNotice(P, P, false), /Could not resume/);
  assert.equal(settledShareNotice('Other error', P, false), 'Other error');
  assert.equal(settledShareNotice('Newer notice', P, true), 'Newer notice');
});

test('vertical toolbar keeps a fixed width over many drags', () => {
  const area = { x: 0, y: 0, width: 1536, height: 824 };
  let natural = { width: 130, height: 612 };
  const fit = fitToolbar('vertical', natural, area, { x: 1200, y: 40 });
  const fixed = { width: fit.width, height: fit.height };
  let b = { x: fit.x, y: fit.y, width: fit.width, height: fit.height };
  for (let i = 0; i < 40; i++) {
    // Windows reports a DIP rounding step more after each move; the panel re-measures +1..2 px.
    const reported = { ...b, x: b.x - 7, width: b.width + 1 };
    b = movedBounds(reported, fixed, area);
    natural = stableNatural(natural, { width: natural.width + (i % 2), height: natural.height });
  }
  assert.equal(b.width, fixed.width);
  assert.equal(natural.width, 130);
  // A real change (more than rounding) is still taken.
  assert.deepEqual(stableNatural({ width: 130, height: 612 }, { width: 180, height: 612 }), { width: 180, height: 612 });
  // Clamped into the work area.
  assert.ok(movedBounds({ x: -500, y: 9999, width: 140, height: 612 }, fixed, area).x >= 0);
});

test('video mode runs at 30 fps; the sidecar helper is started at that rate', () => {
  assert.equal(VIDEO_MODE_SHARE.capture.frameRate, 30);
  assert.equal(VIDEO_MODE_SHARE.encoding.maxFramerate, 30);
  assert.equal(SIDECAR_HELPER_FPS, 30);
  assert.ok(SCREEN_SHARE.capture.frameRate < SIDECAR_HELPER_FPS, 'slides are paced by the sidecar');
});

test('several students drawing are all parsed', () => {
  const h = (id: string) => ({ participantId: id, identity: `student_${id}`, name: id, until: 9e12 });
  const snap = parseRoomState({ code: 'X', name: 'n', status: 'LIVE', isTeacher: true, admitted: [], waiting: [], drawHolder: h('a'), drawHolders: [h('a'), h('b')] });
  assert.deepEqual(snap?.drawHolders.map((x) => x.participantId), ['a', 'b']);
  const old = parseRoomState({ code: 'X', name: 'n', status: 'LIVE', isTeacher: true, admitted: [], waiting: [], drawHolder: h('a') });
  assert.deepEqual(old?.drawHolders.map((x) => x.participantId), ['a']);
});

test('ad-hoc: a clear message when no division is ticked', () => {
  const r = adhocBody({ campus: 'C', grade: '9', divisions: [], all: false, extra: '', subject: '', freeTextExtra: false });
  assert.ok('error' in r && /division/.test(r.error));
});
