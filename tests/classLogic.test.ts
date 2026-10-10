import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSample,
  orderedPins,
  pickTiles,
  rotateOrder,
  liveStudentPool,
  selectStudentTiles,
  sortRoster,
  studentCapForLayout,
  tileCells,
  videoGrid,
} from '../src/shared/classLogic';

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
  assert.deepEqual(
    orderedPins(
      [
        { identity: 'zz', pinnedAt: 1 },
        { identity: 'b', pinnedAt: 2 },
      ],
      ids,
      6
    ),
    ['b']
  );
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
    const out = allocateSample({
      identities: ids,
      teacherPins: [{ identity: 'f', pinnedAt: 1 }],
      speakerPins: [],
      max,
    });
    assert.equal(out.length, max);
    assert.equal(out[0], 'f');
  }
  assert.equal(studentCapForLayout(2), 1);
  assert.equal(studentCapForLayout(4), 3);
  assert.equal(studentCapForLayout(6), 5);
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

test('mosaic keeps pins in front and rotates the remainder', () => {
  const first = selectStudentTiles({
    pool: ['a', 'b', 'c', 'd'],
    teacherPins: ['d'],
    speakingId: null,
    sticky: [],
    prevMosaic: [],
    rotationTick: 0,
    lastTick: 0,
    studentSlots: 3,
    shuffle: (a) => a,
  });
  assert.deepEqual(first.tiles, ['d', 'a', 'b']);
  const next = selectStudentTiles({
    pool: ['a', 'b', 'c', 'd'],
    teacherPins: ['d'],
    speakingId: null,
    sticky: [],
    prevMosaic: first.mosaic,
    rotationTick: 1,
    lastTick: first.lastTick,
    studentSlots: 3,
    shuffle: (a) => a,
  });
  assert.equal(next.tiles[0], 'd');
  assert.deepEqual(rotateOrder(['a', 'b', 'c']), ['b', 'c', 'a']);
});

test('the mosaic rotates only students who have a live camera in the sample', () => {
  assert.deepEqual(
    liveStudentPool({
      visibleIdentities: ['teacher_x', 'a', 'b', 'c'],
      admittedStudentIds: ['a', 'b', 'c', 'd'],
      liveCameraIds: ['a', 'c', 'd', 'teacher_x'],
    }),
    ['a', 'c']
  );
  assert.deepEqual(
    liveStudentPool({
      visibleIdentities: [],
      admittedStudentIds: ['a', 'b'],
      liveCameraIds: ['b', 'stranger'],
    }),
    ['b']
  );
  assert.deepEqual(
    liveStudentPool({
      visibleIdentities: [],
      admittedStudentIds: [],
      liveCameraIds: ['adminobserver_1', 's1', 's1'],
    }),
    ['s1']
  );
});

test('grid and cells: teacher first, blanks fill the layout', () => {
  assert.deepEqual(videoGrid(2, 'dock'), { cols: 2, rows: 1 });
  assert.deepEqual(videoGrid(4, 'dock'), { cols: 2, rows: 2 });
  assert.deepEqual(videoGrid(6, 'dock'), { cols: 3, rows: 2 });
  assert.deepEqual(videoGrid(2, 'share'), { cols: 2, rows: 1 });
  assert.deepEqual(videoGrid(4, 'share'), { cols: 2, rows: 2 });
  assert.deepEqual(videoGrid(6, 'share'), { cols: 3, rows: 2 });
  assert.deepEqual(tileCells(['s1'], 4), ['__self__', 's1', null, null]);
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
  assert.deepEqual(
    sorted.map((p) => p.displayName),
    ['Bob', 'Amy', 'Cat', 'Teacher', 'Abe', 'Zed']
  );
});
