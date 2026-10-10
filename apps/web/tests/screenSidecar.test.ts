import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TrackSource } from 'livekit-server-sdk';
import { isScreenSidecarIdentity, screenSidecarGrant, screenSidecarIdentity } from '../src/lib/livekit';
import { isTeacherIdentity } from '../src/lib/teacherPresenceLogic';

test('screen sidecar: teacher_ prefix (clients treat its share as the teacher\'s), screen sources only, no subscribe/data', () => {
  const id = screenSidecarIdentity('teacher_abc123');
  assert.equal(id, 'teacher_abc123__screen');
  assert.ok(isScreenSidecarIdentity(id));
  assert.ok(!isScreenSidecarIdentity('student_x__screen'));
  assert.ok(isTeacherIdentity(id));
  const g = screenSidecarGrant('classroom_X_s');
  assert.equal(g.canSubscribe, false);
  assert.equal(g.canPublishData, false);
  assert.deepEqual(g.canPublishSources, [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]);
  const route = readFileSync(new URL('../src/app/api/rooms/[code]/screen-token/route.ts', import.meta.url), 'utf8');
  assert.match(route, /getTeacherSession/);
  assert.match(route, /room\.teacherId !== teacher\.id/);
  assert.doesNotMatch(route, /clearStage/);
});
