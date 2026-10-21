import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAW_ALLOW_MS, MAX_DRAWERS, drawersLabel, parseHolders, type DrawHolder } from '../src/lib/drawLogic';
import { STUDENT_GONE_GRACE_MS, isGone, nextLive, parseLive } from '../src/lib/studentPresenceLogic';
import { adhocProblem } from '../src/lib/adhocForm';
import { lobbyEndedFor } from '../src/lib/lobbyState';
import { selfTileLabel } from '../src/lib/rosterLabels';
import { classEndedCopy } from '../src/lib/classFinish';

const h = (id: string, until: number): DrawHolder => ({ participantId: id, identity: `student_${id}`, name: id.toUpperCase(), until });

test('several students hold a draw allow at once; expired ones are dropped', () => {
  const now = 1_000_000;
  const raw = {
    a: JSON.stringify(h('a', now + DRAW_ALLOW_MS)),
    b: JSON.stringify(h('b', now + 1000)),
    c: JSON.stringify(h('c', now - 1)),
    d: 'not json',
  };
  const { active, expired } = parseHolders(raw, now);
  assert.deepEqual(active.map((x) => x.participantId), ['b', 'a']);
  assert.deepEqual(expired.sort(), ['c', 'd']);
  assert.ok(MAX_DRAWERS >= 2);
});

test('drawers label names everyone drawing', () => {
  assert.equal(drawersLabel([]), '');
  assert.equal(drawersLabel(['A']), 'A is drawing');
  assert.equal(drawersLabel(['A', 'B']), 'A and B are drawing');
  assert.equal(drawersLabel(['A', 'B', 'C', 'D']), 'A, B and 2 more are drawing');
});

test('closed tab: student drops off after the grace; reconnect clears it; stale left ignored', () => {
  const t0 = 5_000_000;
  let live = nextLive(null, { kind: 'joined', sid: 'PA_1', at: t0 })!;
  assert.equal(isGone(live, t0 + 60_000), false);
  live = nextLive(live, { kind: 'left', sid: 'PA_1', at: t0 + 1000 })!;
  assert.equal(isGone(live, t0 + 1000 + STUDENT_GONE_GRACE_MS - 1), false);
  assert.equal(isGone(live, t0 + 1000 + STUDENT_GONE_GRACE_MS), true);
  assert.ok(STUDENT_GONE_GRACE_MS <= 5_000, 'drops within ~5 s after leave is recorded');
  // Refresh: new connection comes back.
  const back = nextLive(live, { kind: 'joined', sid: 'PA_2', at: t0 + 3000 })!;
  assert.equal(isGone(back, t0 + 60_000), false);
  // The old connection's late "left" must not mark the new one gone.
  assert.equal(nextLive(back, { kind: 'left', sid: 'PA_1', at: t0 + 4000 }), undefined);
  assert.deepEqual(parseLive(JSON.stringify(back)), back);
  assert.equal(parseLive('{'), null);
});

test('ad-hoc form shows a clear message instead of doing nothing', () => {
  assert.match(adhocProblem({ campus: 'X', grade: '9', all: false, divisions: [] })!, /division/);
  assert.equal(adhocProblem({ campus: 'X', grade: '9', all: false, divisions: ['A'] }), null);
  assert.equal(adhocProblem({ campus: 'X', grade: '9', all: true, divisions: [] }), null);
  assert.match(adhocProblem({ campus: '', grade: '9', all: true, divisions: [] })!, /campus/);
});

test('lobby: class ended while waiting', () => {
  assert.equal(lobbyEndedFor({ status: 'ENDED' }), true);
  assert.equal(lobbyEndedFor({ status: 'LIVE', meLeft: true }), true);
  assert.equal(lobbyEndedFor({ status: 'LIVE' }), false);
  assert.equal(lobbyEndedFor(null), false);
});

test('teacher self tile never reads "You (you)"', () => {
  assert.equal(selfTileLabel('You'), 'You');
  assert.equal(selfTileLabel(''), 'You');
  assert.equal(selfTileLabel('Ms Rao'), 'Ms Rao (you)');
});

test('teacher gets a finished screen after ending the class', () => {
  assert.equal(classEndedCopy(true).title, 'Class finished');
  assert.equal(classEndedCopy(false).title, 'Class ended');
});
