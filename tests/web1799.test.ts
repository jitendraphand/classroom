import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeLivePacket, drawIdentitySet } from '../src/shared/livePackets';
import { acceptWbPacket } from '../src/renderer/whiteboardHost';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const ctx = (ids: string[] = []) => ({ drawTopic: 'draw', drawIdentities: new Set(ids) });

test('cls-signal hand / draw-request pushes refresh the roster', () => {
  const hand = enc({ v: 1, type: 'hand', raised: true, participantId: 'p1' });
  // Students cannot publish data (web main): their hands arrive as the server's push.
  assert.deepEqual(routeLivePacket('cls-signal', 'student_p1', hand, ctx()), { kind: 'ignore' });
  assert.deepEqual(routeLivePacket('cls-signal', undefined, hand, ctx()), { kind: 'signal' });
  const req = enc({ v: 1, type: 'draw-req', on: true, participantId: 'p1' });
  assert.deepEqual(routeLivePacket('cls-signal', undefined, req, ctx()), { kind: 'signal' });
  assert.deepEqual(routeLivePacket('cls-signal', undefined, enc({ v: 2 }), ctx()), { kind: 'ignore' });
  assert.deepEqual(routeLivePacket('cls-signal', undefined, new Uint8Array([1, 2]), ctx()), { kind: 'ignore' });
});

test('draw-allow only from the server, and it feeds the holder set', () => {
  const allow = enc({ v: 1, type: 'draw-allow', on: true, participantId: 'p1', identity: 'student_p1', name: 'A', until: 1 });
  assert.deepEqual(routeLivePacket('cls-signal', undefined, allow, ctx()), { kind: 'signal', allow: { identity: 'student_p1', on: true } });
  assert.deepEqual(routeLivePacket('cls-signal', 'student_p1', allow, ctx()), { kind: 'ignore' });
  const pushes = new Map([['student_p1', true], ['student_p2', false]]);
  assert.deepEqual([...drawIdentitySet([{ identity: 'student_p2' }, { identity: 'student_p3' }], pushes)].sort(), ['student_p1', 'student_p3']);
});

test('state and chat topics still nudge', () => {
  assert.equal(routeLivePacket('cls-state', undefined, enc({}), ctx()).kind, 'state');
  assert.equal(routeLivePacket('chat', 'student_x', enc({}), ctx()).kind, 'chat');
});

test('stroke points only from the server relay (students hold no data grant)', () => {
  const pts = enc({ v: 1, t: 'pts', id: 's1', by: 'student_p1', pts: [] });
  assert.equal(routeLivePacket('draw', 'student_p1', pts, ctx(['student_p1'])).kind, 'ignore');
  assert.equal(routeLivePacket('draw', undefined, pts, ctx()).kind, 'draw');
  const clear = enc({ v: 1, t: 'clear', by: 'student_p1' });
  assert.equal(routeLivePacket('draw', undefined, clear, ctx()).kind, 'draw');
  assert.equal(routeLivePacket('draw', 'teacher_t', clear, ctx()).kind, 'ignore'); // my echo
});

test('whiteboard host takes packets from the server relay only', () => {
  const relayed: any = { v: 1, t: 'ops', ops: [], by: 'student_p1' };
  assert.equal(acceptWbPacket(relayed, undefined), true);
  assert.equal(relayed.by, 'student_p1');
  assert.equal(acceptWbPacket({ v: 1, t: 'ops', ops: [], by: 'student_p1' } as any, 'student_p1'), false);
  assert.equal(acceptWbPacket({ v: 1, t: 'snap' } as any, 'student_p1'), false);
  assert.equal(acceptWbPacket({ v: 1, t: 'ops', ops: [] } as any, 'teacher_x'), false);
});

import { connectRetryDelayMs, CONNECT_RETRY_BASE_MS } from '../src/shared/connectRetry';
import { admitFailureNotice, chatPollSuffix, parseRoomState } from '../src/shared/apiModel';
import { createErrorReporter } from '../src/shared/errorReport';
import fs from 'node:fs';

test('first connect retries with growing, jittered backoff, then gives up', () => {
  assert.equal(connectRetryDelayMs(0, () => 0.5), 1500);
  assert.equal(connectRetryDelayMs(1, () => 0), 3200);
  assert.equal(connectRetryDelayMs(2, () => 1), 10800);
  assert.equal(connectRetryDelayMs(CONNECT_RETRY_BASE_MS.length), null);
  const cs = fs.readFileSync('src/renderer/classSession.ts', 'utf8');
  // Fresh token on every attempt: the token GET sits inside the retry loop.
  assert.match(cs, /for \(let attempt = 0; ; attempt\+\+\) \{\n\s+const tokenRes = await desktop\(\)\.api\('GET', `\/api\/rooms\/\$\{encodeURIComponent\(this\.code\)\}\/token`\)/);
});

test('chat polls ask only for newer messages after the first load', () => {
  assert.equal(chatPollSuffix([]), '/messages');
  assert.equal(
    chatPollSuffix([{ createdAt: '2026-10-24T05:00:00.000Z' }, { createdAt: '2026-10-24T05:01:00.000Z' }, { createdAt: 'junk' }]),
    '/messages?since=2026-10-24T05%3A01%3A00.000Z'
  );
});

test('renderer errors are reported scrubbed and rate limited', async () => {
  const sent: any[] = [];
  let t = 0;
  const report = createErrorReporter({ windowName: 'panel', code: () => 'ABC123', ua: 'ua', post: async (r) => sent.push(r), now: () => t });
  assert.equal(report(new Error('boom at https://x/y?token=eyJaaaaaaaaaaaa.bbb.ccc')), true);
  assert.equal(report(new Error('boom at https://x/y?token=eyJaaaaaaaaaaaa.bbb.ccc')), false); // duplicate
  for (let i = 0; i < 10; i++) report(new Error(`e${i}`));
  assert.equal(sent.length, 5);
  assert.equal(sent[0].code, 'ABC123');
  assert.equal(sent[0].url, 'app://classroom/panel');
  assert.ok(!sent[0].message.includes('eyJ'));
  assert.ok(!sent[0].message.includes('token='));
  t = 61_000;
  assert.equal(report(new Error('later')), true);
  const throwing = createErrorReporter({ windowName: 'w', code: () => '', ua: '', post: () => { throw new Error('no bridge'); } });
  assert.equal(throwing('x'), true);
});

test('state parity fields: spotlight, mic queue, reconnecting; 409 admit says class full', () => {
  const s = parseRoomState({
    code: 'A', admitted: [{ id: 'p1', displayName: 'A', role: 'STUDENT', reconnecting: true }], waiting: [],
    spotlight: { participantId: 'p1', identity: 'student_p1', name: 'A' },
    micLimit: 2, micQueue: [{ id: 'p2', name: 'B', position: 1, source: 'hand' }, { bad: 1 }],
  })!;
  assert.equal(s.admitted[0].reconnecting, true);
  assert.deepEqual(s.spotlight, { participantId: 'p1', identity: 'student_p1', name: 'A' });
  assert.deepEqual(s.micQueue, [{ id: 'p2', name: 'B', position: 1 }]);
  assert.equal(s.micLimit, 2);
  const old = parseRoomState({ code: 'A', admitted: [], waiting: [] })!;
  assert.equal(old.spotlight, null);
  assert.deepEqual(old.micQueue, []);
  assert.match(admitFailureNotice(409, { error: 'This class is full.' })!, /^This class is full\. /);
  assert.equal(admitFailureNotice(200, {}), null);
  const views = fs.readFileSync('src/renderer/teacherViews.tsx', 'utf8');
  assert.match(views, /Speaking queue/);
  assert.match(views, /Stop spotlight/);
  assert.match(views, /Reconnecting/);
});
