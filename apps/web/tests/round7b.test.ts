import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  matchesOccurrenceKey,
  nextOccurrenceRunKey,
  occurrenceBaseKey,
  occurrenceKeyForRun,
  occurrenceRunNumber,
  pickSessionForOccurrence,
} from '../src/lib/occurrenceRuns';
import { effectiveFromForCreate, slotStartsOn } from '../src/lib/slotEffective';
import { studentSearchClause } from '../src/lib/studentSearch';
import { studentVideoModeShortLabel } from '../src/lib/studentVideoMode';
import { displayDivision } from '../src/lib/grades';
import { canSeeSystemTab, privilegeSetFrom, visibleAdminTabs } from '../src/lib/privileges';
import { occurrencesBetween, type SlotLike } from '../src/lib/schedule';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

const IST = 'Asia/Kolkata';

function slot(p: Partial<SlotLike> = {}): SlotLike {
  return {
    id: 's1',
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

test('occurrence reruns: base key, run number, next key, pick live then latest', () => {
  assert.equal(occurrenceBaseKey('slot:abc:2026-10-21'), 'slot:abc:2026-10-21');
  assert.equal(occurrenceBaseKey('slot:abc:2026-10-21#2'), 'slot:abc:2026-10-21');
  assert.equal(occurrenceRunNumber('slot:abc:2026-10-21'), 1);
  assert.equal(occurrenceRunNumber('slot:abc:2026-10-21#3'), 3);
  assert.equal(occurrenceKeyForRun('slot:abc:2026-10-21', 1), 'slot:abc:2026-10-21');
  assert.equal(occurrenceKeyForRun('slot:abc:2026-10-21', 2), 'slot:abc:2026-10-21#2');
  assert.equal(nextOccurrenceRunKey('slot:abc:2026-10-21', ['slot:abc:2026-10-21']), 'slot:abc:2026-10-21#2');
  assert.equal(nextOccurrenceRunKey('slot:abc:2026-10-21', ['slot:abc:2026-10-21', 'slot:abc:2026-10-21#2']), 'slot:abc:2026-10-21#3');
  assert.equal(matchesOccurrenceKey('slot:abc:2026-10-21#2', 'slot:abc:2026-10-21'), true);
  assert.equal(matchesOccurrenceKey('slot:xyz:2026-10-21', 'slot:abc:2026-10-21'), false);

  const rows = [
    { occurrenceKey: 'slot:abc:2026-10-21', startedAt: new Date('2026-10-21T03:30:00Z'), endedAt: new Date('2026-10-21T04:00:00Z') },
    { occurrenceKey: 'slot:abc:2026-10-21#2', startedAt: new Date('2026-10-21T04:05:00Z'), endedAt: null },
  ];
  const live = pickSessionForOccurrence(rows, 'slot:abc:2026-10-21')!;
  assert.equal(live.occurrenceKey, 'slot:abc:2026-10-21#2');
  const endedOnly = pickSessionForOccurrence([rows[0]!], 'slot:abc:2026-10-21')!;
  assert.equal(endedOnly.occurrenceKey, 'slot:abc:2026-10-21');
  assert.equal(pickSessionForOccurrence([], 'slot:abc:2026-10-21'), null);
});

test('startScheduledClass starts a new run after End class instead of reopening the ended row', () => {
  const sessions = src('lib/classSessions.ts');
  assert.match(sessions, /createOccurrenceRun/);
  assert.match(sessions, /nextOccurrenceRunKey/);
  assert.match(sessions, /current\?\.endedAt/);
});

test('feedback form shows a visible error and does not dismiss on 409', () => {
  const form = src('components/classroom/FeedbackForm.tsx');
  assert.match(form, /data-testid="feedback-error"/);
  assert.match(form, /You already sent feedback for this class/);
  assert.doesNotMatch(form, /status === 409[\s\S]{0,80}onDone\(\)/);
});

test('weekly slot with no From date is clipped at creation; explicit From still wins', () => {
  assert.equal(effectiveFromForCreate(null, '2026-10-21'), '2026-10-21');
  assert.equal(effectiveFromForCreate('2026-09-01', '2026-10-21'), '2026-09-01');
  assert.equal(slotStartsOn({ effectiveFrom: null, createdOn: '2026-10-08' }), '2026-10-08');
  assert.equal(slotStartsOn({ effectiveFrom: '2026-10-01', createdOn: '2026-10-08' }), '2026-10-01');

  const noFrom = slot({ createdOn: '2026-10-08' });
  assert.deepEqual(
    occurrencesBetween('2026-09-28', '2026-10-31', [noFrom], [], IST).map((o) => o.date),
    ['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']
  );
  const withFrom = slot({ effectiveFrom: '2026-10-01', createdOn: '2026-10-08' });
  assert.deepEqual(
    occurrencesBetween('2026-09-28', '2026-10-31', [withFrom], [], IST).map((o) => o.date),
    ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']
  );
});

test('createSlot defaults effectiveFrom to the local creation date', () => {
  const admin = src('lib/timetableAdmin.ts');
  assert.match(admin, /effectiveFromForCreate/);
});

test('video panel rail uses a short label; full sentence stays in title/aria', () => {
  assert.equal(studentVideoModeShortLabel('both'), 'Both');
  assert.equal(studentVideoModeShortLabel('teacher'), 'Teacher');
  assert.equal(studentVideoModeShortLabel('min'), 'Hidden');
  const controls = src('components/classroom/Controls.tsx');
  assert.match(controls, /aria-label="Video panel"/);
  assert.match(controls, /data-testid="video-panel"/);
  assert.match(controls, /videoPanelShortLabel/);
  assert.match(controls, /aria-description/);
});

test('division display keeps two-letter codes as entered', () => {
  assert.equal(displayDivision('GA'), 'GA');
  assert.equal(displayDivision('A'), 'A');
  assert.equal(displayDivision('MAHAVEER'), 'Mahaveer');
});

test('Live dashboard tab; System Control hidden when the sub-admin has none of its cards', () => {
  const shell = src('components/admin/AdminShell.tsx');
  assert.match(shell, /Live dashboard/);
  assert.doesNotMatch(shell, /Live classes/);
  const none = privilegeSetFrom({ kind: 'SUB' });
  assert.equal(canSeeSystemTab(none, 'SUB'), false);
  assert.deepEqual(visibleAdminTabs(none, 'SUB'), []);
  const liveOnly = privilegeSetFrom({ kind: 'SUB', privMonitorLive: true });
  assert.equal(canSeeSystemTab(liveOnly, 'SUB'), false);
  assert.ok(!visibleAdminTabs(liveOnly, 'SUB').includes('system'));
  const school = privilegeSetFrom({ kind: 'SUB', privManageSchool: true });
  assert.equal(canSeeSystemTab(school, 'SUB'), true);
});

test('whiteboard is full width; class videos float instead of embedding in a side column', () => {
  const host = src('components/classroom/Whiteboard.tsx');
  assert.doesNotMatch(host, /wb-video-slot/);
  const room = classroomViewSource();
  assert.doesNotMatch(room, /embedHost=\{wbOpen/);
  assert.match(room, /dock=\{wbOpen \? null : dockArea\}/);
});

test('admin students search matches name or student ID case-insensitively', () => {
  assert.equal(studentSearchClause('  '), undefined);
  const clause = studentSearchClause('GA12')!;
  assert.equal(clause.OR.length, 3);
  const name = clause.OR[0] as { name: { contains: string } };
  const ext = clause.OR[1] as { externalId: { contains: string; mode: string } };
  assert.equal(name.name.contains, 'GA12');
  assert.equal(ext.externalId.mode, 'insensitive');
  const page = src('app/admin/students/page.tsx');
  assert.match(page, /data-testid="students-search"/);
  assert.match(page, /Search name or student ID/);
});

test('share/draw: request banner clears when the student is allowed; in-tab dock is top-left', () => {
  const room = classroomViewSource();
  assert.match(room, /stillAsking/);
  assert.match(room, /share-draw-actions/);
  const hud = src('components/classroom/TeacherShareHud.tsx');
  assert.match(hud, /share_controls_v2/);
  assert.match(hud, /data-testid="share-inline-dock"/);
});

test('dropped students: teacher reports ParticipantDisconnected; students disconnect on page leave', () => {
  const room = classroomViewSource();
  assert.match(room, /StudentLeaveOnPageHide/);
  assert.match(room, /disconnectOnPageLeave: !isTeacher/);
  assert.match(room, /\/presence'/);
  const presence = src('app/api/rooms/[code]/presence/route.ts');
  assert.match(presence, /recordStudentConnection/);
});
