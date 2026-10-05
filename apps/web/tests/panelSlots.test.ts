import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelSlotsForCap, studentCapForSlots, videosShown } from '../src/lib/classSlots';

test('panel slots count the teacher tile: cap 5 → 6, cap 3 → 4, cap 1 → 2', () => {
  assert.equal(panelSlotsForCap(5), 6);
  assert.equal(panelSlotsForCap(6), 6); // dashboard 6 cannot exceed the 6-tile panel
  assert.equal(panelSlotsForCap(3), 4);
  assert.equal(panelSlotsForCap(4), 4);
  assert.equal(panelSlotsForCap(2), 2);
  assert.equal(panelSlotsForCap(1), 2);
  assert.equal(studentCapForSlots(6), 5);
  assert.equal(studentCapForSlots(2), 1);
});

test('header matches the pressed digit', () => {
  // Show 2 with plenty of students: you + 1 student.
  assert.deepEqual(videosShown(1, 2), { shown: 2, total: 2 });
  // Show 6, 5 students sampled.
  assert.deepEqual(videosShown(5, 6), { shown: 6, total: 6 });
  // Show 4, only one student in class.
  assert.deepEqual(videosShown(1, 4), { shown: 2, total: 4 });
  // A stale sample larger than the panel never prints more than the panel.
  assert.deepEqual(videosShown(6, 4), { shown: 4, total: 4 });
  assert.deepEqual(videosShown(0, 6), { shown: 1, total: 6 });
});

import { teacherTabTitle } from '../src/lib/classSlots';
test('teacher tab title shows hands and unread', () => {
  assert.equal(teacherTabTitle('Classroom', 0, 0), 'Classroom');
  assert.equal(teacherTabTitle('Classroom', 2, 0), '(✋2) Classroom');
  assert.equal(teacherTabTitle('Classroom', 1, 12), '(✋1 · 9+ new) Classroom');
});
