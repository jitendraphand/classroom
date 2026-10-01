import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forAudience, occurrencesOn, zonedTimeToUtc, type SlotLike } from '../src/lib/schedule';
import { decideRoute, type SessionState } from '../src/lib/studentRouting';

const IST = 'Asia/Kolkata';
const TODAY = '2026-10-01'; // Thursday

function slot(p: Partial<SlotLike>): SlotLike {
  return {
    id: 's',
    teacherId: 't1',
    grade: '7',
    divisions: ['A'],
    allDivisions: false,
    subject: 'Maths',
    weekday: 4,
    startMinute: 9 * 60,
    endMinute: 9 * 60 + 45,
    effectiveFrom: null,
    effectiveTo: null,
    ...p,
  };
}

const slots = [
  slot({ id: 'maths', divisions: ['A', 'B'] }), // combined 7-A + 7-B 09:00-09:45
  slot({ id: 'pe', allDivisions: true, divisions: [], subject: 'PE', startMinute: 11 * 60, endMinute: 11 * 60 + 40 }), // all of grade 7
  slot({ id: 'sci-c', divisions: ['C'], subject: 'Science', startMinute: 10 * 60, endMinute: 10 * 60 + 40 }),
];

const at = (hhmm: string) => zonedTimeToUtc(TODAY, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), IST);

function route(division: string, now: Date, sessions = new Map<string, SessionState>(), liveAdHoc: { id: string; subject: string; startedAt: Date | null }[] = []) {
  const occ = forAudience(occurrencesOn(TODAY, slots, [], IST), '7', division).sort((a, b) => a.start.getTime() - b.start.getTime());
  return decideRoute({ occurrences: occ, sessions, liveAdHoc, now, earlyMinutes: 10, today: TODAY });
}

test('routing: countdown before the early window, open within it', () => {
  const r = route('B', at('08:40'));
  assert.equal(r.kind, 'upcoming');
  if (r.kind === 'upcoming') {
    assert.equal(r.occurrence.slotId, 'maths');
    assert.deepEqual(r.opensAt, at('08:50'));
  }
  const open = route('B', at('08:51'));
  assert.equal(open.kind, 'scheduled');
});

test('routing: late join allowed until the scheduled end', () => {
  assert.equal(route('A', at('09:44')).kind, 'scheduled');
  const after = route('A', at('09:46'));
  assert.equal(after.kind, 'upcoming', 'next is PE for all divisions');
  if (after.kind === 'upcoming') assert.equal(after.occurrence.slotId, 'pe');
});

test('routing: combined and ALL-division slots only reach their audience', () => {
  const c = route('C', at('08:55'));
  assert.equal(c.kind, 'upcoming', 'maths is for A+B only');
  if (c.kind === 'upcoming') assert.equal(c.occurrence.slotId, 'sci-c');
  const pe = route('C', at('11:05'));
  assert.equal(pe.kind, 'scheduled');
  if (pe.kind === 'scheduled') assert.equal(pe.occurrence.slotId, 'pe');
});

test('routing: a class the teacher is still running wins, even past its end', () => {
  const key = occurrencesOn(TODAY, slots, [], IST).find((o) => o.slotId === 'maths')!.key;
  const sessions = new Map<string, SessionState>([[key, { id: 'cs1', live: true, startedAt: at('09:00'), endedAt: null }]]);
  const r = route('A', at('09:55'), sessions);
  assert.equal(r.kind, 'scheduled');
});

test('routing: ended early today, ad-hoc live, nothing left', () => {
  const key = occurrencesOn(TODAY, slots, [], IST).find((o) => o.slotId === 'maths')!.key;
  const ended = new Map<string, SessionState>([[key, { id: 'cs1', live: false, startedAt: at('09:00'), endedAt: at('09:20') }]]);
  const r = route('A', at('09:30'), ended);
  assert.equal(r.kind, 'upcoming', 'falls through to the next class today');
  const adhoc = route('A', at('15:00'), new Map(), [{ id: 'cs9', subject: 'Revision', startedAt: at('14:55') }]);
  assert.equal(adhoc.kind, 'adhoc');
  const none = route('A', at('15:00'));
  assert.equal(none.kind, 'none');
});

test('routing: timezone — the class day is the school day, not UTC', () => {
  // 09:00 IST is 03:30 UTC.
  assert.equal(at('09:00').toISOString(), '2026-10-01T03:30:00.000Z');
});
