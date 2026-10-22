import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_JITTER_MS,
  HEARTBEAT_RECONNECTING_MS,
  HEARTBEAT_STALE_MS,
  LOST_GRACE_MS,
  STUDENT_GONE_GRACE_MS,
  heartbeatPeriodMs,
  applyHeartbeat,
  connectionPhase,
  isGone,
  nextLive,
  nextPresencePhase,
  parseBeat,
  parseLive,
  rosterHidden,
} from '../src/lib/studentPresenceLogic';

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

test('heartbeat: interval ≥30s with jitter; a late beat stays listed; no beat is not stale', () => {
  const t0 = 5_000_000;
  assert.ok(HEARTBEAT_INTERVAL_MS >= 30_000);
  assert.ok(HEARTBEAT_JITTER_MS >= 0);
  assert.equal(heartbeatPeriodMs(0), HEARTBEAT_INTERVAL_MS);
  assert.equal(heartbeatPeriodMs(1), HEARTBEAT_INTERVAL_MS + HEARTBEAT_JITTER_MS);
  assert.ok(HEARTBEAT_RECONNECTING_MS > HEARTBEAT_INTERVAL_MS);
  assert.ok(HEARTBEAT_RECONNECTING_MS < HEARTBEAT_STALE_MS);
  assert.equal(LOST_GRACE_MS, 5_000);
  const live = { sid: 'PA_1' };
  const beat = { at: t0 };
  assert.equal(connectionPhase(live, beat, t0 + HEARTBEAT_INTERVAL_MS), 'ok', 'one interval stays');
  assert.equal(rosterHidden(live, beat, t0 + HEARTBEAT_INTERVAL_MS), false);
  assert.equal(connectionPhase(live, beat, t0 + HEARTBEAT_RECONNECTING_MS), 'reconnecting');
  assert.equal(rosterHidden(live, beat, t0 + HEARTBEAT_RECONNECTING_MS), false);
  assert.equal(connectionPhase(live, beat, t0 + HEARTBEAT_STALE_MS - 1), 'reconnecting');
  assert.equal(rosterHidden(live, beat, t0 + HEARTBEAT_STALE_MS), false);
  assert.equal(connectionPhase(live, beat, t0 + HEARTBEAT_STALE_MS), 'reconnecting');
  assert.equal(connectionPhase(live, null, t0 + 60_000), 'ok', 'missing beat is not stale');
  assert.equal(rosterHidden(null, null, t0 + 60_000), false);
  assert.equal(parseBeat(null), null);
  assert.equal(parseBeat('nope'), null);
  assert.deepEqual(parseBeat(String(t0)), { at: t0 });
});

test('heartbeat: explicit leave still uses the short grace, even with a fresh beat', () => {
  const t0 = 6_000_000;
  const live = { sid: 'PA_1', gone: t0 };
  const fresh = { at: t0 + 1_000 };
  assert.equal(rosterHidden(live, fresh, t0 + STUDENT_GONE_GRACE_MS - 1), false);
  assert.equal(connectionPhase(live, fresh, t0 + STUDENT_GONE_GRACE_MS - 1), 'reconnecting');
  assert.equal(rosterHidden(live, fresh, t0 + STUDENT_GONE_GRACE_MS), true);
  assert.equal(connectionPhase(live, fresh, t0 + STUDENT_GONE_GRACE_MS), 'gone');
});

test('heartbeat: a different sid is ignored while healthy and accepted when reconnecting', () => {
  const t0 = 7_000_000;
  const cur = { sid: 'PA_1' };
  const fresh = { at: t0 };
  const ignored = applyHeartbeat(cur, fresh, { at: t0 + 500, sid: 'PA_OLD' });
  assert.equal(ignored.ignore, true);
  const healthy = applyHeartbeat(cur, fresh, { at: t0 + 2_000, sid: 'PA_1' });
  assert.equal(healthy.ignore, false);
  if (!healthy.ignore) assert.equal(healthy.nudge, false, 'a healthy beat must not nudge');
  const late = { at: t0 };
  const backAt = t0 + HEARTBEAT_RECONNECTING_MS + 1;
  const back = applyHeartbeat(cur, late, { at: backAt, sid: 'PA_2' });
  assert.equal(back.ignore, false);
  if (!back.ignore) {
    assert.equal(back.nudge, true);
    assert.deepEqual(back.live, { sid: 'PA_2' });
    assert.equal(connectionPhase(back.live, back.beat, backAt), 'ok');
  }
  const gone = applyHeartbeat({ sid: 'PA_1', gone: t0 }, { at: t0 - 20_000 }, { at: t0 + HEARTBEAT_STALE_MS + 1_000, sid: 'PA_3' });
  assert.equal(gone.ignore, false);
  if (!gone.ignore) {
    assert.equal(gone.nudge, true);
    assert.equal(gone.live.gone, undefined);
  }
});

test('teacher lost-quality grace: reconnecting immediately, gone at 5s, ok clears it', () => {
  const t0 = 8_000_000;
  assert.equal(nextPresencePhase('present', t0, 'lost', t0), 'reconnecting');
  assert.equal(nextPresencePhase('reconnecting', t0, 'lost', t0 + LOST_GRACE_MS - 1), 'reconnecting');
  assert.equal(nextPresencePhase('reconnecting', t0, 'lost', t0 + LOST_GRACE_MS), 'gone');
  assert.equal(nextPresencePhase('gone', t0, 'lost', t0 + 60_000), 'gone');
  assert.equal(nextPresencePhase('gone', t0, 'ok', t0 + 60_000), 'present');
  assert.equal(nextPresencePhase('present', t0, 'left', t0), 'reconnecting');
  assert.equal(nextPresencePhase('reconnecting', t0, 'left', t0 + STUDENT_GONE_GRACE_MS - 1), 'reconnecting');
  assert.equal(nextPresencePhase('reconnecting', t0, 'left', t0 + STUDENT_GONE_GRACE_MS), 'gone');
  assert.equal(nextPresencePhase('reconnecting', t0, 'ok', t0 + 1_000), 'present');
});
