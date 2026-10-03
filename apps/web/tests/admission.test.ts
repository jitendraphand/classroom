import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idsToAdmitOnToggle, shouldAutoAdmit } from '../src/lib/admissionLogic';

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
