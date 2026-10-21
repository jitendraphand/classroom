import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STUDENT_GONE_GRACE_MS, isGone, nextLive, parseLive } from '../src/lib/studentPresenceLogic';

test('presence: join, leave after grace drops, reconnect within grace stays, stale left ignored', () => {
  const t0 = 1_000_000;
  let live = nextLive(null, { kind: 'joined', sid: 'PA_1', at: t0 })!;
  assert.equal(isGone(live, t0 + 60_000), false);

  live = nextLive(live, { kind: 'left', sid: 'PA_1', at: t0 + 200 })!;
  assert.equal(isGone(live, t0 + 200 + STUDENT_GONE_GRACE_MS - 1), false, 'still within grace');
  assert.equal(isGone(live, t0 + 200 + STUDENT_GONE_GRACE_MS), true);
  assert.ok(STUDENT_GONE_GRACE_MS <= 5_000, 'target drop is ~5 s after the leave is recorded');

  const back = nextLive(live, { kind: 'joined', sid: 'PA_2', at: t0 + 400 })!;
  assert.equal(isGone(back, t0 + 60_000), false);
  assert.equal(nextLive(back, { kind: 'left', sid: 'PA_1', at: t0 + 800 }), undefined, 'stale left of the old sid');
  assert.deepEqual(parseLive(JSON.stringify(back)), back);
  assert.equal(parseLive('{'), null);
  assert.equal(parseLive(null), null);
});

test('presence: a second left on an already-gone record is ignored', () => {
  const t0 = 2_000_000;
  const gone = nextLive({ sid: 'PA_1' }, { kind: 'left', sid: 'PA_1', at: t0 })!;
  assert.equal(nextLive(gone, { kind: 'left', sid: 'PA_1', at: t0 + 50 }), undefined);
});
