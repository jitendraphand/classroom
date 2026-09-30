import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackSource } from 'livekit-server-sdk';
import { chatAudience, type AudiencePerson } from '../src/lib/chatAudience';
import { classroomGrant, livekitRoomName, publishSourcesFor } from '../src/lib/livekit';

const people: AudiencePerson[] = [
  { id: 't1', role: 'TEACHER', livekitIdentity: 'teacher_x' },
  { id: 's1', role: 'STUDENT', livekitIdentity: 'student_1' },
  { id: 's2', role: 'STUDENT', livekitIdentity: 'student_2' },
  { id: 's3', role: 'STUDENT', livekitIdentity: 'student_3' },
];

test('broadcast chat reaches everyone admitted', () => {
  const a = chatAudience({ scope: 'BROADCAST', senderParticipantId: 't1', recipientParticipantId: null }, people);
  assert.deepEqual(a.sort(), ['student_1', 'student_2', 'student_3', 'teacher_x']);
});

test('teacher DM reaches only the teacher and that student', () => {
  const a = chatAudience({ scope: 'DIRECT', senderParticipantId: 't1', recipientParticipantId: 's2' }, people);
  assert.deepEqual(a.sort(), ['student_2', 'teacher_x']);
});

test('student → teacher message reaches only the teacher and the sender', () => {
  const a = chatAudience({ scope: 'TEACHER', senderParticipantId: 's3', recipientParticipantId: null }, people);
  assert.deepEqual(a.sort(), ['student_3', 'teacher_x']);
});

test('student grant: no data publishing, no screen share', () => {
  const g = classroomGrant({ role: 'STUDENT', roomName: 'r', allowCamera: true, mutedByTeacher: false });
  assert.equal(g.canPublishData, false);
  assert.deepEqual(g.canPublishSources, [TrackSource.CAMERA, TrackSource.MICROPHONE]);
});

test('student outside the sample and teacher-muted can publish nothing', () => {
  const g = classroomGrant({ role: 'STUDENT', roomName: 'r', allowCamera: false, mutedByTeacher: true });
  assert.deepEqual(g.canPublishSources, []);
});

test('teacher grant: all sources + data', () => {
  const g = classroomGrant({ role: 'TEACHER', roomName: 'r' });
  assert.equal(g.canPublishData, true);
  assert.deepEqual(g.canPublishSources, [
    TrackSource.CAMERA,
    TrackSource.MICROPHONE,
    TrackSource.SCREEN_SHARE,
    TrackSource.SCREEN_SHARE_AUDIO,
  ]);
});

test('publishSourcesFor never adds screen share unless asked', () => {
  assert.deepEqual(publishSourcesFor({ allowCamera: true, allowMic: true }), [
    TrackSource.CAMERA,
    TrackSource.MICROPHONE,
  ]);
});

test('LiveKit room name changes with the session id', () => {
  assert.notEqual(livekitRoomName('ABC123', 's1'), livekitRoomName('ABC123', 's2'));
  assert.equal(livekitRoomName('ABC123', 's1'), 'classroom_ABC123_s1');
});
