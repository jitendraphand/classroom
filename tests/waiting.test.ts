import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idsToAdmitOnToggle,
  oldestWaiting,
  reduceWaiting,
  shouldAutoAdmit,
  type WaitingRoomState,
} from '../src/shared/waiting';

test('waiting room on: nobody is auto-admitted', () => {
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: true }, { role: 'STUDENT', status: 'WAITING' }), false);
});

test('waiting room off: waiting students are admitted on arrival', () => {
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: false }, { role: 'STUDENT', status: 'WAITING' }), true);
  assert.equal(shouldAutoAdmit({ status: 'WAITING', waitingRoomOn: false }, { role: 'STUDENT', status: 'WAITING' }), true);
});

test('waiting room off never admits into an ended class, re-admits, or touches teachers', () => {
  assert.equal(shouldAutoAdmit({ status: 'ENDED', waitingRoomOn: false }, { role: 'STUDENT', status: 'WAITING' }), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: false }, { role: 'STUDENT', status: 'ADMITTED' }), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: false }, { role: 'STUDENT', status: 'LEFT' }), false);
  assert.equal(shouldAutoAdmit({ status: 'LIVE', waitingRoomOn: false }, { role: 'TEACHER', status: 'WAITING' }), false);
});

test('turning the waiting room off admits everyone waiting; turning it on admits nobody', () => {
  const people = [
    { id: 'a', role: 'STUDENT', status: 'WAITING' },
    { id: 'b', role: 'STUDENT', status: 'ADMITTED' },
    { id: 'c', role: 'STUDENT', status: 'WAITING' },
  ];
  assert.deepEqual(idsToAdmitOnToggle(false, people), ['a', 'c']);
  assert.deepEqual(idsToAdmitOnToggle(true, people), []);
});

const base = (): WaitingRoomState => ({
  on: true,
  waiting: [
    { id: 'a', displayName: 'Asha', createdAt: '2026-10-03T10:00:00.000Z' },
    { id: 'b', displayName: 'Ben', createdAt: '2026-10-03T10:01:00.000Z' },
  ],
  admittedIds: ['t'],
});

test('admit one moves that student and leaves the others waiting', () => {
  const r = reduceWaiting(base(), { type: 'admit', id: 'b' });
  assert.deepEqual(r.admitIds, ['b']);
  assert.deepEqual(
    r.state.waiting.map((w) => w.id),
    ['a']
  );
  assert.deepEqual(r.state.admittedIds, ['t', 'b']);
  assert.equal(r.state.on, true);
});

test('admit all and toggle-off empty the waiting list; toggle-on admits nobody', () => {
  const all = reduceWaiting(base(), { type: 'admit-all' });
  assert.deepEqual(all.admitIds, ['a', 'b']);
  assert.deepEqual(all.state.waiting, []);
  const off = reduceWaiting(base(), { type: 'toggle', on: false });
  assert.deepEqual(off.admitIds, ['a', 'b']);
  assert.equal(off.state.on, false);
  const on = reduceWaiting(off.state, { type: 'toggle', on: true });
  assert.deepEqual(on.admitIds, []);
  assert.equal(on.state.on, true);
});

test('admitting someone who is not waiting is a no-op', () => {
  const r = reduceWaiting(base(), { type: 'admit', id: 'missing' });
  assert.deepEqual(r.admitIds, []);
  assert.equal(r.state.waiting.length, 2);
});

test('oldest waiting student is first by createdAt', () => {
  const w = oldestWaiting([
    { id: 'b', displayName: 'Ben', createdAt: '2026-10-03T10:01:00.000Z' },
    { id: 'a', displayName: 'Asha', createdAt: '2026-10-03T10:00:00.000Z' },
  ]);
  assert.equal(w?.id, 'a');
});
