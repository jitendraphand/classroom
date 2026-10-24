import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinSpreadForRoom, joinSpreadCapMs, clientConnectDelayMs } from '../src/lib/joinPacingLogic';
import { connectRetryDelayMs, CONNECT_RETRY_MAX_MS } from '../src/lib/rejoinPolicy';

const root = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('join spread scales with room size, bounded by base and cap', () => {
  assert.equal(joinSpreadForRoom(0, {}), 15_000);
  assert.equal(joinSpreadForRoom(300, {}), 15_000);
  assert.equal(joinSpreadForRoom(1500, {}), 50_000); // 1500 / 30 per s
  assert.equal(joinSpreadForRoom(10_000, {}), 90_000);
  assert.equal(joinSpreadForRoom(1500, { JOIN_CONNECT_RATE: '20' }), 75_000);
  assert.equal(joinSpreadForRoom(1500, { JOIN_SPREAD_CAP_MS: '30000' }), 30_000);
  assert.equal(joinSpreadForRoom(1500, { JOIN_SPREAD_MAX_MS: '0' }), 0);
  assert.equal(joinSpreadCapMs({ JOIN_SPREAD_CAP_MS: '999999' }), 180_000);
  assert.equal(clientConnectDelayMs({ connectDelayMs: 60_000 }), 60_000);
});

test('connect retry backoff grows per consecutive failure, jittered, capped', () => {
  assert.equal(connectRetryDelayMs(1, () => 1), 2_000);
  assert.equal(connectRetryDelayMs(1, () => 0), 1_000);
  assert.equal(connectRetryDelayMs(3, () => 1), 8_000);
  assert.equal(connectRetryDelayMs(50, () => 1), CONNECT_RETRY_MAX_MS);
  assert.ok(connectRetryDelayMs(2, () => 0.5) >= 2_000);
  const room = root('src/components/classroom/ClassroomRoom.tsx');
  assert.match(room, /connectFailuresRef\.current \+= 1/);
  assert.match(room, /connectFailuresRef\.current = 0/);
});

