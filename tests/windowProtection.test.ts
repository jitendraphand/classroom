import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { WINDOW_CAPTURE_DECISIONS, isOfferedShareWindow, windowShouldBeCaptureExcluded } from '../src/shared/capture';

const mainSrc = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

test('every documented window decision matches windowShouldBeCaptureExcluded', () => {
  for (const [name, d] of Object.entries(WINDOW_CAPTURE_DECISIONS)) {
    assert.equal(windowShouldBeCaptureExcluded(name), !d.captured, `${name}: ${d.why}`);
    assert.ok(d.why.length > 5, `${name} needs a reason`);
  }
});

test('only the transparent overlay and the region picker are captured', () => {
  const captured = Object.entries(WINDOW_CAPTURE_DECISIONS)
    .filter(([, d]) => d.captured)
    .map(([n]) => n)
    .sort();
  assert.deepEqual(captured, ['annotate-overlay', 'region-picker']);
  // The new annotation panel is opaque and excluded, like the toolbar.
  assert.equal(windowShouldBeCaptureExcluded('annotate-tools'), true);
  assert.equal(windowShouldBeCaptureExcluded('toolbar'), true);
  assert.equal(windowShouldBeCaptureExcluded('main'), true);
  // Unknown future popups default to excluded.
  assert.equal(windowShouldBeCaptureExcluded('some-new-popup'), true);
});

test('every literal window name main.ts registers has a documented decision', () => {
  const names = new Set<string>();
  for (const m of mainSrc.matchAll(/watch\(\w+, '([a-z-]+)'\)/g)) names.add(m[1]!);
  for (const m of mainSrc.matchAll(/for \(const name of \[([^\]]+)\]\)/g)) {
    for (const n of m[1]!.matchAll(/'([a-z-]+)'/g)) names.add(n[1]!);
  }
  for (const n of ['chat', 'roster', 'devices']) names.add(n);
  assert.ok(names.has('annotate-tools'));
  for (const n of names) assert.ok(n in WINDOW_CAPTURE_DECISIONS, `${n} is not in WINDOW_CAPTURE_DECISIONS`);
});

test('the annotation panel is protected before its first show and never offered as a share source', () => {
  const start = mainSrc.indexOf('function openAnnotateTools');
  const body = mainSrc.slice(start, mainSrc.indexOf('function closeAnnotateTools'));
  const protect = body.indexOf("protectExcludedWindow(win, 'annotate-tools')");
  const show = body.indexOf('win.show()');
  assert.ok(protect > 0 && show > protect, 'protect before show');
  assert.match(body, /transparent: false/);
  assert.equal(isOfferedShareWindow('Annotate tools'), false);
});
