import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forAudience, occurrencesOn, zonedTimeToUtc, type SlotLike } from '../src/lib/schedule';
import { decideRoute, type AdHocLive, type SessionState } from '../src/lib/studentRouting';

const IST = 'Asia/Kolkata';
const TODAY = '2026-10-01'; // Thursday

function slot(p: Partial<SlotLike>): SlotLike {
  return {
    id: 's',
    teacherId: 't1',
    campus: 'CC',
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

function route(division: string, now: Date, sessions = new Map<string, SessionState>(), liveAdHoc: AdHocLive[] = []) {
  const occ = forAudience(occurrencesOn(TODAY, slots, [], IST), { campus: 'CC', grade: '7', division }).sort((a, b) => a.start.getTime() - b.start.getTime());
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

test('routing: own-division ad-hoc class beats a live all-divisions timetabled class (Nov 7 trial)', () => {
  const peKey = occurrencesOn(TODAY, slots, [], IST).find((o) => o.slotId === 'pe')!.key;
  const sessions = new Map<string, SessionState>([[peKey, { id: 'cs-pe', live: true, startedAt: at('11:00'), endedAt: null }]]);
  const adhocB = { id: 'cs-b', subject: 'Revision B', startedAt: at('11:05'), divisions: ['B'], allDivisions: false };
  const b = route('B', at('11:10'), sessions, [adhocB]);
  assert.equal(b.kind, 'adhoc', 'division B goes to its own ad-hoc class');
  if (b.kind === 'adhoc') assert.equal(b.session.id, 'cs-b');
  // A student of another division still gets the all-divisions class.
  const a = route('A', at('11:10'), sessions);
  assert.equal(a.kind, 'scheduled');
  if (a.kind === 'scheduled') assert.equal(a.occurrence.slotId, 'pe');
});

test('routing: own-division timetabled class beats a live all-divisions ad-hoc class', () => {
  const key = occurrencesOn(TODAY, slots, [], IST).find((o) => o.slotId === 'maths')!.key;
  const sessions = new Map<string, SessionState>([[key, { id: 'cs-m', live: true, startedAt: at('09:00'), endedAt: null }]]);
  const whole = { id: 'cs-all', subject: 'Assembly', startedAt: at('08:55'), divisions: [], allDivisions: true };
  const r = route('A', at('09:10'), sessions, [whole]);
  assert.equal(r.kind, 'scheduled');
  if (r.kind === 'scheduled') assert.equal(r.occurrence.slotId, 'maths');
});

test('routing: single-division class beats a combined one; ties keep timetabled, then earliest ad-hoc', async () => {
  const { audienceSpecificity } = await import('../src/lib/studentRouting');
  assert.ok(audienceSpecificity({ divisions: ['B'], allDivisions: false }) > audienceSpecificity({ divisions: ['A', 'B'], allDivisions: false }));
  assert.ok(audienceSpecificity({ divisions: ['A', 'B'], allDivisions: false }) > audienceSpecificity({ divisions: [], allDivisions: true }));
  assert.equal(audienceSpecificity({}), 0, 'legacy ad-hoc without audience = whole grade');
  const key = occurrencesOn(TODAY, slots, [], IST).find((o) => o.slotId === 'maths')!.key; // A+B combined
  const sessions = new Map<string, SessionState>([[key, { id: 'cs-m', live: true, startedAt: at('09:00'), endedAt: null }]]);
  const single = route('B', at('09:10'), sessions, [{ id: 'cs-b', subject: 'B only', startedAt: at('09:05'), divisions: ['B'], allDivisions: false }]);
  assert.equal(single.kind, 'adhoc');
  const tie = route('B', at('09:10'), sessions, [{ id: 'cs-ab', subject: 'A+B', startedAt: at('09:05'), divisions: ['A', 'B'], allDivisions: false }]);
  assert.equal(tie.kind, 'scheduled', 'equal specificity keeps the timetabled class');
  const two = route('B', at('09:10'), new Map(), [
    { id: 'first', subject: 'x', startedAt: at('09:01'), divisions: ['B'], allDivisions: false },
    { id: 'second', subject: 'y', startedAt: at('09:02'), divisions: ['B'], allDivisions: false },
  ]);
  assert.ok(two.kind === 'adhoc' && two.session.id === 'first');
});
