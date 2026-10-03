import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSample, orderedPins, pickTiles, sortRoster } from '../src/lib/classSlots';

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

test('pins take slots first, oldest pin first, and count toward the cap', () => {
  const out = allocateSample({
    identities: ids,
    teacherPins: [
      { identity: 'g', pinnedAt: 20 },
      { identity: 'c', pinnedAt: 10 },
    ],
    speakerPins: ['e'],
    max: 3,
  });
  assert.deepEqual(out, ['c', 'g', 'e']);
});

test('more pins than slots: the oldest pins win, cap is never exceeded', () => {
  const pins = ['a', 'b', 'c', 'd'].map((identity, i) => ({ identity, pinnedAt: 100 - i }));
  const out = allocateSample({ identities: ids, teacherPins: pins, speakerPins: ['h'], max: 2 });
  assert.deepEqual(out, ['d', 'c']);
});

test('pins of students who are not in the room are ignored', () => {
  assert.deepEqual(orderedPins([{ identity: 'zz', pinnedAt: 1 }, { identity: 'b', pinnedAt: 2 }], ids, 6), ['b']);
});

test('speakers come after pins, then rotation fills the rest', () => {
  const out = allocateSample({
    identities: ids,
    teacherPins: [{ identity: 'h', pinnedAt: 1 }],
    speakerPins: ['b', 'zz'],
    max: 5,
  });
  assert.deepEqual(out, ['h', 'b', 'a', 'c', 'd']);
  assert.equal(new Set(out).size, out.length);
});

test('slot counts 1 / 3 / 5 (2 / 4 / 6 tiles with the teacher)', () => {
  for (const max of [1, 3, 5]) {
    const out = allocateSample({ identities: ids, teacherPins: [{ identity: 'f', pinnedAt: 1 }], speakerPins: [], max });
    assert.equal(out.length, max);
    assert.equal(out[0], 'f');
  }
});

test('tiles: pinned, then active speaker, sticky speakers, rotation; only publishing students', () => {
  const tiles = pickTiles({
    pool: ['a', 'b', 'c', 'd', 'e'],
    teacherPins: ['d', 'x'],
    speakingId: 'b',
    sticky: ['e'],
    rotation: ['c', 'a'],
    studentSlots: 4,
  });
  assert.deepEqual(tiles, ['d', 'b', 'e', 'c']);
  assert.deepEqual(pickTiles({ pool: ['a'], teacherPins: [], rotation: [], studentSlots: 3 }), ['a']);
  assert.deepEqual(pickTiles({ pool: ['a', 'b'], teacherPins: ['b'], rotation: ['a'], studentSlots: 1 }), ['b']);
});

test('roster: raised hands first by raise time, then teacher, then names', () => {
  const sorted = sortRoster([
    { id: '1', displayName: 'Zed', role: 'STUDENT' },
    { id: '2', displayName: 'Amy', role: 'STUDENT', handRaised: true, handRaisedAt: 300 },
    { id: '3', displayName: 'Teacher', role: 'TEACHER' },
    { id: '4', displayName: 'Bob', role: 'STUDENT', handRaised: true, handRaisedAt: 100 },
    { id: '5', displayName: 'Cat', role: 'STUDENT', handRaised: true },
    { id: '6', displayName: 'Abe', role: 'STUDENT' },
  ]);
  assert.deepEqual(sorted.map((p) => p.displayName), ['Bob', 'Amy', 'Cat', 'Teacher', 'Abe', 'Zed']);
});
