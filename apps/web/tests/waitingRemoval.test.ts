import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('both teacher rosters expose Remove via the scoped leave endpoint (no Deny: no waiting room)', () => {
  for (const file of ['ClassroomRoom', 'TeacherShareHud']) {
    const src = readFileSync(`src/components/classroom/${file}.tsx`, 'utf8');
    assert.doesNotMatch(src, /aria-label=\{`Deny /);
    assert.match(src, /aria-label=\{`Remove /);
  }
  const leave = readFileSync('src/app/api/rooms/[code]/leave/route.ts', 'utf8');
  assert.match(leave, /if \(!isRoomTeacher\) return/);
  assert.match(leave, /roomId: room.id, role: 'STUDENT'/);
  assert.match(leave, /status: 'LEFT'/);
  assert.match(leave, /removeLiveKitParticipant/);
});
test('a removed student sees it on the joining page and can join again', () => {
  const lobby = readFileSync('src/app/join/[code]/page.tsx', 'utf8');
  assert.ok(lobby.indexOf('waiting && roomInfo?.meLeft') < lobby.indexOf('waiting && lobbyEnded'));
  assert.match(lobby, /You were removed from the class/);
});
