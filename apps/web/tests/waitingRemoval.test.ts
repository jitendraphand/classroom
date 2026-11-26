import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('both teacher rosters expose Deny and Remove via the scoped leave endpoint', () => {
  for (const file of ['ClassroomRoom', 'TeacherShareHud']) {
    const src = readFileSync(`src/components/classroom/${file}.tsx`, 'utf8');
    assert.match(src, /aria-label=\{`Deny /);
    assert.match(src, /aria-label=\{`Remove /);
  }
  const leave = readFileSync('src/app/api/rooms/[code]/leave/route.ts', 'utf8');
  assert.match(leave, /if \(!isRoomTeacher\) return/);
  assert.match(leave, /roomId: room.id, role: 'STUDENT'/);
  assert.match(leave, /status: 'LEFT'/);
  assert.match(leave, /removeLiveKitParticipant/);
});
test('school reentry cannot auto-admit a previously denied or removed student', () => {
  // A student who pressed Leave may come straight back (direct entry); a seat
  // the teacher denied or removed blocks it (tests/directEntry.test.ts).
  const src = readFileSync('src/lib/studentService.ts', 'utf8');
  assert.match(src, /directEntryAllowed\(earlier\) && shouldAutoAdmit/);
  assert.match(src, /status: 'WAITING'/);
  const manual = readFileSync('src/app/api/rooms/[code]/join/route.ts', 'utf8');
  assert.match(manual, /directEntryAllowed\(previous\) && shouldAutoAdmit/);
  const lobby = readFileSync('src/app/join/[code]/page.tsx', 'utf8');
  assert.ok(lobby.indexOf('waiting && roomInfo?.meLeft') < lobby.indexOf('waiting && lobbyEnded'));
});
