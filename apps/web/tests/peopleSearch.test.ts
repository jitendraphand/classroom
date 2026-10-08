import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMessages, filterPeople, matchesPerson } from '../src/lib/peopleSearch';

const people = [
  { id: '1', displayName: 'Aryan Patil', sid: 'GOS000123' },
  { id: '2', displayName: 'Meera  Shah', sid: 'GOS000456' },
  { id: '3', displayName: 'Guest', sid: null },
];

test('people: name or SID, case and spaces ignored', () => {
  assert.deepEqual(filterPeople(people, 'aryan').map((p) => p.id), ['1']);
  assert.deepEqual(filterPeople(people, ' meera shah ').map((p) => p.id), ['2']);
  assert.deepEqual(filterPeople(people, 'gos000456').map((p) => p.id), ['2']);
  assert.deepEqual(filterPeople(people, 'GOS 000').map((p) => p.id), ['1', '2']);
  assert.equal(filterPeople(people, '').length, 3);
  assert.equal(matchesPerson(people[2], 'gos'), false);
});

test('messages: sender, recipient, body or SID', () => {
  const msgs = [
    { id: 'a', senderName: 'Aryan Patil', senderParticipantId: '1', recipientName: null, recipientParticipantId: null, body: 'Hello' },
    { id: 'b', senderName: 'Teacher', senderParticipantId: 't', recipientName: 'Meera Shah', recipientParticipantId: '2', body: 'Page 4' },
    { id: 'c', senderName: 'Teacher', senderParticipantId: 't', recipientName: null, recipientParticipantId: null, body: 'Homework' },
  ];
  const sids = new Map(people.map((p) => [p.id, p.sid]));
  assert.deepEqual(filterMessages(msgs, 'meera').map((m) => m.id), ['b']);
  assert.deepEqual(filterMessages(msgs, 'homework').map((m) => m.id), ['c']);
  assert.deepEqual(filterMessages(msgs, 'gos000123', sids).map((m) => m.id), ['a']);
  assert.equal(filterMessages(msgs, '  ').length, 3);
});
