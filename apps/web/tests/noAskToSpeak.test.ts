import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

// Nov 22: the student "Ask to speak" button duplicated Raise hand and was removed.
test('student controls have Raise hand but no Ask to speak button', () => {
  const controls = src('components/classroom/Controls.tsx');
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.doesNotMatch(controls, /ask-to-speak|onAskToSpeak|Ask to speak/);
  assert.doesNotMatch(room, /onAskToSpeak|askToSpeakLabel|'Ask to speak'/);
  assert.match(room, /onToggleHand: isTeacher \? undefined : toggleHand/);
  // The "hand raised" hint and the teacher-queued waiting note stay.
  assert.match(room, /Hand raised\. Your teacher can let you speak\./);
  assert.match(room, /Waiting to speak/);
});
