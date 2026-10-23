import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modifyLabel, substituteProblem } from '../src/lib/overrideRules';
import { occurrenceConflicts, occurrencesOn, type OverrideLike, type SlotLike } from '../src/lib/schedule';

test('substitute must differ from the original teacher', () => {
  assert.match(substituteProblem('MODIFY', 't1', 't1', 'Asha')!, /different teacher from Asha/);
  assert.equal(substituteProblem('MODIFY', 't2', 't1'), null);
  assert.equal(substituteProblem('MODIFY', null, 't1'), null, 'time-only change keeps the teacher');
  assert.equal(substituteProblem('EXTRA', 't1', 't1'), null);
});

test('MODIFY label: substitute vs time change', () => {
  assert.equal(modifyLabel({ teacherId: 't2', originalTeacherId: 't1' }), 'Substitute');
  assert.equal(modifyLabel({ teacherId: null, originalTeacherId: 't1', startMinute: 600 }), 'Time change');
  assert.equal(modifyLabel({ teacherId: 't1', originalTeacherId: 't1', start: '10:00' }), 'Time change');
  assert.equal(modifyLabel({ teacherId: null, originalTeacherId: 't1' }), 'Changed');
});

const slot = (id: string, teacherId: string, start: number, end: number): SlotLike => ({
  id, teacherId, campus: 'MAIN', grade: '5', divisions: [id], allDivisions: false, subject: id,
  weekday: 1, startMinute: start, endMinute: end, effectiveFrom: null, effectiveTo: null, academicYear: '2026-27',
} as SlotLike);
const D = '2026-10-26'; // Monday

test('substitute clash: weekly class, extra class, cancellation honoured', () => {
  const slots = [slot('a', 'T1', 540, 585), slot('b', 'T2', 560, 600)];
  const sub: OverrideLike = { id: 'c', kind: 'MODIFY', date: D, slotId: 'a', teacherId: 'T2', divisions: [], allDivisions: false } as unknown as OverrideLike;
  let occs = occurrencesOn(D, slots, [sub], 'Asia/Kolkata');
  assert.equal(occurrenceConflicts(occs).teacher.length, 1, 'T2 busy with own weekly class');
  const cancelB: OverrideLike = { id: 'x', kind: 'CANCEL', date: D, slotId: 'b', divisions: [], allDivisions: false } as unknown as OverrideLike;
  occs = occurrencesOn(D, slots, [sub, cancelB], 'Asia/Kolkata');
  assert.equal(occurrenceConflicts(occs).teacher.length, 0, 'cancelled class frees the substitute');
  const extra: OverrideLike = { id: 'e', kind: 'EXTRA', date: D, slotId: null, teacherId: 'T2', campus: 'MAIN', grade: '6', divisions: ['A'], allDivisions: false, startMinute: 570, endMinute: 600, subject: 'X' } as unknown as OverrideLike;
  occs = occurrencesOn(D, slots, [sub, cancelB, extra], 'Asia/Kolkata');
  assert.equal(occurrenceConflicts(occs).teacher.length, 1, 'extra class clashes');
});
