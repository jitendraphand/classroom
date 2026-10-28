import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROSTER_PAGE, rosterWindow } from '../src/lib/rosterWindow';

test('roster window: first page, then more on request; small classes render whole', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => i);
  const a = rosterWindow(rows, ROSTER_PAGE);
  assert.equal(a.shown.length, ROSTER_PAGE);
  assert.equal(a.hidden, 2500 - ROSTER_PAGE);
  assert.equal(a.next, ROSTER_PAGE);
  const b = rosterWindow(rows, 2400);
  assert.equal(b.hidden, 100);
  assert.equal(b.next, 100);
  const small = rosterWindow([1, 2, 3], ROSTER_PAGE);
  assert.deepEqual(small, { shown: [1, 2, 3], hidden: 0, next: 0 });
  assert.equal(rosterWindow(rows, 0).shown.length, ROSTER_PAGE, 'never less than a page');
});
