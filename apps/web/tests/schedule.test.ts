import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  forAudience,
  localDateOf,
  localMinuteOf,
  occurrenceConflicts,
  occurrencesBetween,
  occurrencesOn,
  phaseOf,
  slotConflicts,
  slotProblem,
  weekdayOf,
  zonedTimeToUtc,
  type OverrideLike,
  type SlotLike,
} from '../src/lib/schedule';

const IST = 'Asia/Kolkata';

function slot(p: Partial<SlotLike> = {}): SlotLike {
  return {
    id: 's1',
    teacherId: 't1',
    grade: '7',
    divisions: ['A'],
    allDivisions: false,
    subject: 'Maths',
    weekday: 4, // Thursday
    startMinute: 9 * 60,
    endMinute: 9 * 60 + 45,
    effectiveFrom: null,
    effectiveTo: null,
    ...p,
  };
}

function ov(p: Partial<OverrideLike>): OverrideLike {
  return {
    id: 'o1',
    kind: 'CANCEL',
    date: '2026-10-01',
    slotId: 's1',
    teacherId: null,
    grade: null,
    divisions: [],
    allDivisions: false,
    subject: null,
    startMinute: null,
    endMinute: null,
    note: null,
    ...p,
  };
}

test('dates: weekday and day arithmetic', () => {
  assert.equal(weekdayOf('2026-10-01'), 4); // Thursday
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('timezone: 09:00 in Asia/Kolkata is 03:30 UTC', () => {
  assert.equal(zonedTimeToUtc('2026-10-01', 9 * 60, IST).toISOString(), '2026-10-01T03:30:00.000Z');
  // Local date flips at 18:30 UTC.
  assert.equal(localDateOf(new Date('2026-10-01T18:29:00Z'), IST), '2026-10-01');
  assert.equal(localDateOf(new Date('2026-10-01T18:31:00Z'), IST), '2026-10-02');
  assert.equal(localMinuteOf(new Date('2026-10-01T03:30:00Z'), IST), 540);
});

test('timezone: configurable zone with DST (America/New_York)', () => {
  // EDT (UTC-4) in October, EST (UTC-5) in December.
  assert.equal(zonedTimeToUtc('2026-10-01', 9 * 60, 'America/New_York').toISOString(), '2026-10-01T13:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-12-03', 9 * 60, 'America/New_York').toISOString(), '2026-12-03T14:00:00.000Z');
});

test('weekly recurrence: slot appears on its weekday every week only', () => {
  const occs = occurrencesBetween('2026-09-28', '2026-10-11', [slot()], [], IST);
  assert.deepEqual(occs.map((o) => o.date), ['2026-10-01', '2026-10-08']);
  assert.equal(occs[0]!.key, 'slot:s1:2026-10-01');
  assert.equal(occs[0]!.start.toISOString(), '2026-10-01T03:30:00.000Z');
  assert.equal(occs[0]!.end.toISOString(), '2026-10-01T04:15:00.000Z');
});

test('effective date range limits a slot', () => {
  const s = slot({ effectiveFrom: '2026-10-05', effectiveTo: '2026-10-20' });
  const occs = occurrencesBetween('2026-09-28', '2026-10-31', [s], [], IST);
  assert.deepEqual(occs.map((o) => o.date), ['2026-10-08', '2026-10-15']);
});

test('override CANCEL removes only that date', () => {
  const occs = occurrencesBetween('2026-10-01', '2026-10-08', [slot()], [ov({ kind: 'CANCEL' })], IST);
  assert.deepEqual(occs.map((o) => o.date), ['2026-10-08']);
});

test('override MODIFY: substitute teacher and new time, same occurrence key', () => {
  const [o] = occurrencesOn(
    '2026-10-01',
    [slot()],
    [ov({ kind: 'MODIFY', teacherId: 't2', startMinute: 10 * 60, endMinute: 10 * 60 + 30, note: 'Sub' })],
    IST
  );
  assert.equal(o!.teacherId, 't2');
  assert.equal(o!.originalTeacherId, 't1');
  assert.equal(o!.startMinute, 600);
  assert.equal(o!.key, 'slot:s1:2026-10-01');
  assert.equal(o!.modified, true);
  assert.equal(o!.subject, 'Maths');
});

test('override EXTRA adds a one-off class', () => {
  const occs = occurrencesOn(
    '2026-10-02',
    [slot()],
    [ov({ id: 'x1', kind: 'EXTRA', date: '2026-10-02', slotId: null, teacherId: 't3', grade: '8', allDivisions: true, subject: 'Assembly', startMinute: 600, endMinute: 660 })],
    IST
  );
  assert.equal(occs.length, 1);
  assert.equal(occs[0]!.key, 'extra:x1');
  assert.equal(occs[0]!.extra, true);
  assert.equal(occs[0]!.allDivisions, true);
});

test('combined and ALL-division slots match their students', () => {
  const slots = [
    slot({ id: 'comb', divisions: ['A', 'B'] }),
    slot({ id: 'all', teacherId: 't2', grade: '8', divisions: [], allDivisions: true }),
  ];
  const occs = occurrencesOn('2026-10-01', slots, [], IST);
  assert.deepEqual(forAudience(occs, '7', 'B').map((o) => o.slotId), ['comb']);
  assert.deepEqual(forAudience(occs, '7', 'C').map((o) => o.slotId), []);
  assert.deepEqual(forAudience(occs, '8', 'Z').map((o) => o.slotId), ['all']);
  assert.deepEqual(forAudience(occs, ' 7 ', 'a').map((o) => o.slotId), ['comb']);
});

test('early window: opens 10 min before start; late join allowed until the end', () => {
  const [o] = occurrencesOn('2026-10-01', [slot()], [], IST); // 09:00–09:45 IST = 03:30–04:15Z
  const at = (iso: string) => phaseOf(o!, new Date(iso), 10);
  assert.equal(at('2026-10-01T03:19:59Z'), 'upcoming');
  assert.equal(at('2026-10-01T03:20:00Z'), 'open'); // 08:50 IST
  assert.equal(at('2026-10-01T03:30:00Z'), 'open');
  assert.equal(at('2026-10-01T04:14:59Z'), 'open'); // late join until end
  assert.equal(at('2026-10-01T04:15:00Z'), 'past');
  assert.equal(phaseOf(o!, new Date('2026-10-01T03:25:00Z'), 0), 'upcoming');
});

test('slot validation and overlap rules', () => {
  assert.equal(slotProblem(slot()), null);
  assert.ok(slotProblem(slot({ endMinute: 9 * 60 })));
  assert.ok(slotProblem(slot({ divisions: [] })));
  assert.equal(slotProblem(slot({ divisions: [], allDivisions: true })), null);

  const existing = [slot()];
  // Same teacher, overlapping time → teacher conflict.
  const c1 = slotConflicts({ ...slot({ id: undefined as unknown as string, grade: '9', startMinute: 9 * 60 + 30, endMinute: 600 }) }, existing);
  assert.equal(c1.teacher.length, 1);
  // Back-to-back is fine.
  assert.equal(slotConflicts(slot({ id: 'n', startMinute: 9 * 60 + 45, endMinute: 600 }), existing).teacher.length, 0);
  // Other teacher, same grade-division → audience conflict; ALL overlaps any division.
  assert.equal(slotConflicts(slot({ id: 'n', teacherId: 't2' }), existing).audience.length, 1);
  assert.equal(slotConflicts(slot({ id: 'n', teacherId: 't2', divisions: [], allDivisions: true }), existing).audience.length, 1);
  assert.equal(slotConflicts(slot({ id: 'n', teacherId: 't2', divisions: ['B'] }), existing).audience.length, 0);
  // Other weekday or non-overlapping term → no conflict; editing itself → no conflict.
  assert.equal(slotConflicts(slot({ id: 'n', weekday: 5 }), existing).teacher.length, 0);
  assert.equal(slotConflicts(slot({ id: 's1' }), existing).teacher.length, 0);
  const termed = [slot({ effectiveTo: '2026-10-31' })];
  assert.equal(slotConflicts(slot({ id: 'n', effectiveFrom: '2026-11-01' }), termed).teacher.length, 0);
});

test('override conflicts: substitute already teaching at that time', () => {
  const slots = [slot(), slot({ id: 's2', teacherId: 't2', grade: '9', divisions: ['A'] })];
  const occs = occurrencesOn('2026-10-01', slots, [ov({ kind: 'MODIFY', teacherId: 't2' })], IST);
  const c = occurrenceConflicts(occs);
  assert.equal(c.teacher.length, 1);
});
