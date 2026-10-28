import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyJoin, applyLeave, closeAll, emptyConn, settleAfterEnd } from '../src/lib/attendance';

const root = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const T = (s: number) => new Date(1_800_000_000_000 + s * 1000);

test('settleAfterEnd: never-connected record gets the end as leave time', () => {
  const s = settleAfterEnd(emptyConn(), T(600));
  assert.equal(s.leftAt?.getTime(), T(600).getTime());
  assert.equal(s.connectedMs, 0);
});

test('settleAfterEnd: a late-flushed join after the end close is closed at the end', () => {
  const closed = closeAll(applyLeave(applyJoin(emptyConn(), 'a', T(0)), 'a', T(100)), T(600));
  const reopened = applyJoin(closed, 'b', T(500)); // joined before end, flushed after
  const s = settleAfterEnd(reopened, T(600));
  assert.deepEqual(s.openSids, []);
  assert.equal(s.connectedSince, null);
  assert.equal(s.leftAt?.getTime(), T(600).getTime());
  assert.equal(s.connectedMs, 100_000 + 100_000);
});

test('settleAfterEnd: keeps an early leave and no-ops before the end', () => {
  const left = applyLeave(applyJoin(emptyConn(), 'a', T(0)), 'a', T(100));
  assert.equal(settleAfterEnd(left, T(600)).leftAt?.getTime(), T(100).getTime());
  const open = applyJoin(emptyConn(), 'a', T(0));
  assert.equal(settleAfterEnd(open, null), open);
});

test('class end stamps leftAt on every record; queue flush settles after the end', () => {
  const svc = root('src/lib/attendanceService.ts');
  assert.match(svc, /"leftAt" IS NULL AND "connectedSince" IS NULL\s+AND cardinality\(COALESCE\("openSids"/);
  assert.match(svc, /return settleAfterEnd\(s, sessionEndedAt\)/);
  const q = root('src/lib/attendanceQueue.ts');
  // The flush passes the session's end time so late joins settle at the end.
  assert.match(q, /const ended = endedAt\.get\(g\.cs\) \?\? null;/);
  assert.match(q, /applyConnectionEvents\([\s\S]{0,200}ended\s*\);/);
});
