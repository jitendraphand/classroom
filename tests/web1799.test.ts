import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeLivePacket, drawIdentitySet } from '../src/shared/livePackets';
import { acceptWbPacket } from '../src/renderer/whiteboardHost';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const ctx = (ids: string[] = []) => ({ drawTopic: 'draw', drawIdentities: new Set(ids) });

test('cls-signal hand / draw-request pushes refresh the roster', () => {
  const hand = enc({ v: 1, type: 'hand', raised: true, participantId: 'p1' });
  assert.deepEqual(routeLivePacket('cls-signal', 'student_p1', hand, ctx()), { kind: 'signal' });
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

test('student stroke points: only their own, only while allowed to draw', () => {
  const pts = enc({ v: 1, t: 'pts', id: 's1', by: 'student_p1', pts: [] });
  assert.equal(routeLivePacket('draw', 'student_p1', pts, ctx(['student_p1'])).kind, 'draw');
  assert.equal(routeLivePacket('draw', 'student_p1', pts, ctx([])).kind, 'ignore'); // no permission
  assert.equal(routeLivePacket('draw', 'student_p2', pts, ctx(['student_p2'])).kind, 'ignore'); // forged by
  const clear = enc({ v: 1, t: 'clear', by: 'student_p1' });
  assert.equal(routeLivePacket('draw', 'student_p1', clear, ctx(['student_p1'])).kind, 'ignore');
  assert.equal(routeLivePacket('draw', undefined, clear, ctx()).kind, 'draw'); // server
  assert.equal(routeLivePacket('draw', 'teacher_t', clear, ctx()).kind, 'ignore'); // my echo
});

test('whiteboard host accepts student ops stamped with their identity', () => {
  const ops: any = { v: 1, t: 'ops', ops: [], by: 'student_other' };
  assert.equal(acceptWbPacket(ops, 'student_p1'), true);
  assert.equal(ops.by, 'student_p1');
  assert.equal(acceptWbPacket({ v: 1, t: 'snap' } as any, 'student_p1'), false);
  assert.equal(acceptWbPacket({ v: 1, t: 'ops', ops: [] } as any, 'teacher_x'), false);
  assert.equal(acceptWbPacket({ v: 1, t: 'ops', ops: [] } as any, 'guest_x'), false);
  const relayed: any = { v: 1, t: 'ops', ops: [], by: 'student_p1' };
  assert.equal(acceptWbPacket(relayed, undefined), true);
  assert.equal(relayed.by, 'student_p1');
});
