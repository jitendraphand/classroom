import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotClashes, type ClashSlot } from '../src/lib/timetableClashes';

const slot = (id: string, over: Partial<ClashSlot> = {}): ClashSlot => ({
  id,
  teacherId: 't1',
  campus: 'MAIN',
  grade: '7',
  divisions: ['A'],
  allDivisions: false,
  weekday: 1,
  start: '09:00',
  end: '09:45',
  effectiveFrom: null,
  effectiveTo: null,
  ...over,
});

test('same teacher or same class at overlapping times clash', () => {
  // Same teacher, different class, overlapping.
  assert.deepEqual([...slotClashes([slot('a'), slot('b', { grade: '8', start: '09:30', end: '10:15' })])].sort(), ['a', 'b']);
  // Different teacher, same division.
  assert.deepEqual([...slotClashes([slot('a'), slot('b', { teacherId: 't2' })])].sort(), ['a', 'b']);
  // Whole-grade slot overlaps any division of that grade.
  assert.equal(slotClashes([slot('a'), slot('b', { teacherId: 't2', divisions: [], allDivisions: true })]).size, 2);
});

test('back-to-back, other days, other classes and separate date ranges do not clash', () => {
  assert.equal(slotClashes([slot('a'), slot('b', { start: '09:45', end: '10:30' })]).size, 0);
  assert.equal(slotClashes([slot('a'), slot('b', { weekday: 2 })]).size, 0);
  assert.equal(slotClashes([slot('a'), slot('b', { teacherId: 't2', divisions: ['B'] })]).size, 0);
  assert.equal(slotClashes([slot('a'), slot('b', { teacherId: 't2', campus: 'NORTH' })]).size, 0);
  assert.equal(
    slotClashes([slot('a', { effectiveTo: '2026-06-30' }), slot('b', { effectiveFrom: '2026-07-01' })]).size,
    0
  );
});
